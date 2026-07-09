// Client side of the analysis pipeline: image prep → local neural net (walls/
// doors/windows) + Claude (semantics, scale, plan type) → merge → ScenePlan.
import { analysisToScenePlan, geometryQuality } from './planProcess.js'
import { segmentPlanImage, isUsableGeometry } from './planseg.js'

const MAX_DIM = 2576 // Sonnet 5 high-res vision limit; coords map 1:1 to pixels, so thin walls/door arcs/mm text survive that 1568px lost
const MIN_DIM = 1100 // below this, upscale: more visual tokens = thin walls survive
// Vercel serverless bodies cap at ~4.5MB; the refine pass sends image + JSON,
// so keep the encoded image comfortably under that.
const MAX_DATAURL = 3_500_000
const MIN_ENCODE_DIM = 1568 // guard-shrink floor: at 1568/JPEG the body always fit before

export async function prepareImage(file) {
  const bitmap = await loadBitmap(file)
  const maxSide = Math.max(bitmap.width, bitmap.height)
  const scale = maxSide > MAX_DIM ? MAX_DIM / maxSide
    : maxSide < MIN_DIM ? Math.min(MAX_DIM / maxSide, 2.5)
    : 1
  let w = Math.round(bitmap.width * scale)
  let h = Math.round(bitmap.height * scale)
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
    // A 2576px JPEG can still blow the serverless body limit. Shrink and redraw
    // from the original bitmap (never re-encode the lossy JPEG) until it fits.
    while (dataUrl.length > MAX_DATAURL && Math.round(Math.max(w, h) * 0.8) >= MIN_ENCODE_DIM) {
      w = Math.round(w * 0.8)
      h = Math.round(h * 0.8)
      canvas.width = w // resets ctx state, so re-apply smoothing/background
      canvas.height = h
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(bitmap, 0, 0, w, h)
      dataUrl = canvas.toDataURL('image/jpeg', 0.9)
    }
  }
  // The upscale exists for Claude's vision (more visual tokens). It actively
  // HURTS the segmentation net — a blurry 2x blowup reads far worse than the
  // crisp original — so keep native pixels for the net when we upscaled.
  // (Original is small by definition here, so the extra canvas is cheap.)
  let nnDataUrl = dataUrl
  if (scale > 1) {
    const nc = document.createElement('canvas')
    nc.width = bitmap.width
    nc.height = bitmap.height
    const nctx = nc.getContext('2d')
    nctx.fillStyle = '#ffffff'
    nctx.fillRect(0, 0, nc.width, nc.height)
    nctx.drawImage(bitmap, 0, 0)
    nnDataUrl = nc.toDataURL('image/png')
  }
  return { base64: dataUrl.split(',')[1], mediaType, dataUrl, nnDataUrl, width: w, height: h }
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
  'Stride is reading the plan…',
  'Classifying it — floor plan, office or site…',
  'Tracing every wall, corner to corner…',
  'Finding doors, doorways and windows…',
  'Labeling the rooms…',
  'Reading printed dimensions to get the scale exactly right…',
  'Double-checking short walls that are easy to miss…',
  'Almost there — packaging the geometry…',
]

// Build both candidate worlds and score them: enclosure coverage minus
// dangling-wall penalty (see geometryQuality). The model wins ties — its
// coordinates are pixel-precise where Claude's drift — but a fragmented
// extraction loses to a coherent Claude one instead of shipping stub walls.
// The model wins on precision but can miss whole walls on unfamiliar plan
// styles; Claude sees those but drifts on coordinates. Union: keep every
// model wall, and add Claude walls that have no model counterpart along
// most of their length. Downstream cleanup (collinear merge, orphan prune)
// and the quality gate keep the occasional Claude hallucination in check.
function pointSegDist(p, a, b) {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const lenSq = abx * abx + aby * aby || 1e-9
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq))
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t))
}

// The model is trained to see THROUGH furniture symbols — X-box wardrobes,
// stair railings, dimension lines — that Claude still traces as walls. When
// the model's segmentation confidently classified an entire line as
// background, a Claude wall there is almost always a misread symbol; a
// genuinely missed wall leaves at least fragments of wall/door/window class
// along its path. Lenient threshold so real recoveries survive.
function modelSawNothing(cw, cm) {
  const len = Math.hypot(cw.end.x - cw.start.x, cw.end.y - cw.start.y)
  const steps = Math.max(6, Math.round(len / 12))
  let sampled = 0
  let structural = 0
  for (let i = 0; i <= steps; i++) {
    // interior only: a Claude wall's ENDPOINTS land on corners/T-junctions
    // of real walls by construction, so they always read as structure
    const t = 0.12 + 0.76 * (i / steps)
    const ix = Math.round((cw.start.x + (cw.end.x - cw.start.x) * t) / cm.scaleX)
    const iy = Math.round((cw.start.y + (cw.end.y - cw.start.y) * t) / cm.scaleY)
    if (ix < 2 || iy < 2 || ix >= cm.w - 2 || iy >= cm.h - 2) continue
    sampled++
    let hit = false
    for (let oy = -2; oy <= 2 && !hit; oy++) {
      for (let ox = -2; ox <= 2; ox++) {
        if (cm.data[(iy + oy) * cm.w + ix + ox] !== 0) { hit = true; break }
      }
    }
    if (hit) structural++
  }
  return sampled >= 4 && structural / sampled < 0.15
}

export function unionWalls(modelWalls, claudeWalls, classMap) {
  const out = [...modelWalls]
  for (const cw of claudeWalls || []) {
    if (!cw?.start || !cw?.end) continue
    const tol = Math.max(14, (cw.thickness || 10) * 1.6)
    let covered = 0
    for (const t of [0.15, 0.5, 0.85]) {
      const p = { x: cw.start.x + (cw.end.x - cw.start.x) * t, y: cw.start.y + (cw.end.y - cw.start.y) * t }
      if (modelWalls.some((mw) => pointSegDist(p, mw.start, mw.end) < tol)) covered++
    }
    if (covered <= 1) {
      if (classMap && modelSawNothing(cw, classMap)) continue
      out.push({ ...cw, fromClaude: true })
    }
  }
  return out
}

function geometryQualityOf(analysis) {
  try {
    return geometryQuality(analysisToScenePlan(analysis))
  } catch {
    return 0
  }
}

// Candidate worlds, best one wins: the model's geometry alone, the model's
// geometry + Claude's walls unioned in (recovers model-missed walls, but can
// also import a Claude hallucination like a balcony railing read as walls),
// Claude's walls filtered by the model's background veto, and Claude's raw
// geometry. Model-family candidates are pixel-precise and symbol-aware where
// Claude's tracing drifts and varies run to run, so a Claude candidate must
// BEAT the best model-family score by a clear margin (not just edge it out)
// before it ships — close calls go to the model.
const CLAUDE_MARGIN = 1.12
export function pickGeometry(local, claude) {
  const hybridBase = { ...claude, doors: local.doors, windows: local.windows, imageSize: local.imageSize }
  const cm = local.classMap
  const vetoedClaudeWalls = cm
    ? (claude.walls || []).filter((w) => !(w?.start && w?.end && modelSawNothing(w, cm)))
    : null
  // trust: model-family (0) > claude-vetoed (1) > raw claude (2). A less
  // trusted candidate must clear the margin, not just edge ahead — phantom
  // walls (a hallucinated closet) INCREASE raw enclosure, so the score alone
  // systematically flatters raw claude.
  const candidates = [
    { label: 'model+union', trust: 0, claudeFamily: false, analysis: { ...hybridBase, walls: unionWalls(local.walls, claude.walls, cm) } },
    { label: 'model', trust: 0, claudeFamily: false, analysis: { ...hybridBase, walls: local.walls } },
    ...(vetoedClaudeWalls ? [{ label: 'claude-vetoed', trust: 1, claudeFamily: true, analysis: { ...claude, walls: vetoedClaudeWalls } }] : []),
    { label: 'claude', trust: 2, claudeFamily: true, analysis: claude },
  ]
  for (const c of candidates) c.q = geometryQualityOf(c.analysis)
  let best = null
  for (const c of candidates) {
    if (!best) { best = c; continue }
    const need = c.trust > best.trust ? best.q * CLAUDE_MARGIN : best.q
    if (c.q > need) best = c
  }
  console.info('[stride] geometry — picked ' + best.label + ' (' +
    candidates.map((c) => `${c.label}: ${c.q.toFixed(3)}`).join(', ') + ')')
  return best
}

export async function analyzeUpload(file, onStatus, signal) {
  onStatus?.('Preparing image…')
  const prepped = await prepareImage(file)

  // Local neural net and Claude run in parallel. The model owns geometry
  // (walls/doors/windows — pixel-precise, instant, free); Claude owns
  // semantics (plan type, room names/types, scale from printed dimensions).
  onStatus?.('Reading the plan with Stride’s neural net…')
  const localPromise = segmentPlanImage(prepped.nnDataUrl, prepped.width, prepped.height)

  let stage = 0
  onStatus?.(ANALYSIS_STAGES[0])
  const rotate = setInterval(() => {
    stage = Math.min(stage + 1, ANALYSIS_STAGES.length - 1) // hold on the last line
    onStatus?.(ANALYSIS_STAGES[stage])
  }, 5000)

  let claude = null
  let claudeError = null
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: prepped.base64, mediaType: prepped.mediaType }),
      signal,
    })
    const payload = await res.json().catch(() => ({}))
    if (res.ok && payload.analysis) claude = payload.analysis
    else claudeError = new Error(payload.error || `Analysis failed (${res.status})`)
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    claudeError = err
  } finally {
    clearInterval(rotate)
  }

  const local = await localPromise
  const localUsable = isUsableGeometry(local)

  // Which geometry builds the best world? (Claude's room centers are in the
  // same pixel space as the model's walls — both saw the same prepared image.)
  const picked = claude && claude.planType !== 'site' && localUsable ? pickGeometry(local, claude) : null

  let analysis
  if (claude && claude.planType === 'site') {
    // site plans have no walls to segment — Claude owns them end to end
    analysis = claude
  } else if (claude && picked && picked.label !== 'claude') {
    analysis = picked.analysis
    onStatus?.('Merging Stride’s two readings of your plan…')
  } else if (claude) {
    // model unavailable/uncertain → Claude-only, with its verification pass
    analysis = claude
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
  } else if (localUsable && geometryQualityOf(local) > 0.3) {
    // no Claude (no API key, offline, quota) but the model read the plan
    // coherently: build anyway — rooms get synthesized from the geometry,
    // scale from door widths. Uploads work with zero API cost.
    analysis = local
    onStatus?.('Building from the neural net’s reading (no API key needed)…')
  } else {
    throw claudeError || new Error('The analyzer returned nothing usable.')
  }

  onStatus?.('Building the 3D world…')
  const plan = analysisToScenePlan(analysis)
  if (plan.planType !== 'site' && (!plan.walls?.length || !plan.rooms?.length)) {
    throw new Error(
      'No usable walls or rooms were detected. Try a clearer plan image — dark wall lines on a light background work best.'
    )
  }
  // which reading built this world — shown in the expanded map, and the
  // first thing to check when a user reports a bad conversion
  plan.geometrySource = claude && claude.planType === 'site' ? 'claude (site)'
    : picked && picked.label !== 'claude' ? picked.label
    : claude ? 'claude+refine'
    : 'model (no key)'
  return { plan, preview: prepped.dataUrl }
}
