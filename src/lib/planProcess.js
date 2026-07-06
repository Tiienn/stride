// Plan processing: converts raw analysis (pixels) or authored fixtures (meters)
// into the canonical ScenePlan the 3D layer consumes.
//
// ScenePlan {
//   planType: 'floor' | 'office' | 'site'
//   name: string
//   walls: [{ id, start:{x,z}, end:{x,z}, height, thickness, isExterior,
//             openings: [{ id, type:'door'|'doorway'|'entrance'|'window',
//                          position (m from start, center), width, height, sillHeight }] }]
//   rooms: [{ id, name, type, center:{x,z}, area, floorRects, bbox }]
//   grid: { originX, originZ, w, h, cell, cells: Int16Array }  // -1 wall, -2 outside, >=0 room idx
//   bounds: { minX, maxX, minZ, maxZ }
//   site: { boundary:[{x,z}], areaM2, roadEdge } | null
//   spawn: { x, z, angle }
//   scaleInfo: { pixelsPerMeter, confidence, source }
// }

import { inferRoomType } from './roomTypes.js'

const WALL_HEIGHT = 2.7
const CELL = 0.1
// Player capsule radius — keep in sync with RADIUS in scene/Player.jsx. Wall
// collision extends half the wall thickness past each door jamb, so an opening
// is only walkable when width > 2*(PLAYER_RADIUS + thickness/2).
const PLAYER_RADIUS = 0.28

const dist2d = (a, b) => Math.hypot(b.x - a.x, b.z - a.z)

let idCounter = 0
const uid = (p) => `${p}-${++idCounter}`

// ---------------------------------------------------------------------------
// Pixel-space analysis  →  world-space plan
// ---------------------------------------------------------------------------

export function analysisToScenePlan(analysis) {
  if (analysis.planType === 'site') return siteAnalysisToScenePlan(analysis)

  const ppm = crossCheckScale(resolveScale(analysis), analysis)
  let plan = buildInterior(analysis, ppm)

  // Area calibration: plans routinely print each room's area ("21.4 m²").
  // Comparing the printed labels against the flood-filled built areas gives
  // an exact correction for any residual scale error — the labels are ground
  // truth in a way pixel measurements never are.
  const k = areaCalibrationFactor(plan.rooms)
  if (k) {
    plan = buildInterior(analysis, ppm / k)
    plan.scaleInfo = { pixelsPerMeter: ppm / k, confidence: 0.95, source: 'area_calibrated' }
  }
  return plan
}

// Median sqrt(labeledArea / builtArea) over labeled rooms — the linear factor
// the world is off by. Null when there's nothing trustworthy to calibrate on.
function areaCalibrationFactor(rooms) {
  const ratios = (rooms || [])
    .filter((r) => r.labeledArea > 0.5 && r.area > 0.5)
    .map((r) => r.labeledArea / r.area)
    // a single wildly-off pair is a mislabel or a room-matching failure
    .filter((q) => q > 0.25 && q < 4)
    .sort((a, b) => a - b)
  if (!ratios.length) return null
  const k = Math.sqrt(ratios[Math.floor(ratios.length / 2)])
  if (!(k > 0.5 && k < 2)) return null
  return Math.abs(k - 1) > 0.03 ? k : null
}

function buildInterior(analysis, ppm) {
  const size = analysis.imageSize || guessImageSize(analysis)
  const cx = size.width / 2
  const cy = size.height / 2
  const toWorld = (p) => ({ x: (p.x - cx) / ppm, z: (p.y - cy) / ppm })

  let walls = (analysis.walls || [])
    .filter((w) => w?.start && w?.end)
    .map((w) => ({
      id: uid('wall'),
      start: toWorld(w.start),
      end: toWorld(w.end),
      height: WALL_HEIGHT,
      thickness: clamp((w.thickness || 12) / ppm, 0.08, 0.4),
      isExterior: !!w.isExterior,
      openings: [],
    }))
    .filter((w) => dist2d(w.start, w.end) > 0.3)

  walls = axisAlign(walls)
  walls = snapEndpoints(walls, 0.3)
  walls = mergeDuplicateWalls(walls, 0.25)
  walls = mergeCollinearOverlaps(walls)
  walls = snapTJunctions(walls, 0.35)
  walls = sealCollinearGaps(walls)
  walls = pruneOrphanWalls(walls)

  for (const d of analysis.doors || []) {
    if (!d?.center) continue
    attachOpening(walls, toWorld(d.center), {
      type: d.kind === 'entrance' ? 'entrance' : d.kind === 'doorway' ? 'doorway' : 'door',
      width: clamp((d.width || 0.9 * ppm) / ppm, 0.75, d.kind === 'doorway' ? 3.2 : 1.5),
      height: 2.05,
      sillHeight: 0,
    })
  }
  for (const w of analysis.windows || []) {
    if (!w?.center) continue
    attachOpening(walls, toWorld(w.center), {
      type: 'window',
      width: clamp((w.width || 1.2 * ppm) / ppm, 0.5, 3.0),
      height: 1.35,
      sillHeight: 0.9,
    })
  }
  enforcePassableOpenings(walls)

  const rooms = (analysis.rooms || [])
    .filter((r) => r?.center)
    .map((r) => ({
      id: uid('room'),
      name: r.name || 'Room',
      type: r.type || inferRoomType(r.name, analysis.planType === 'floor_office' ? 'office' : 'floor'),
      center: toWorld(r.center),
      labeledArea: r.labeledArea || null,
    }))

  return finalizeInteriorPlan({
    planType: analysis.planType === 'floor_office' ? 'office' : 'floor',
    name: analysis.planName || 'Uploaded plan',
    walls,
    rooms,
    scaleInfo: { pixelsPerMeter: ppm, confidence: analysis.scale?.confidence ?? 0.5, source: analysis.scale?.source || 'estimated' },
  })
}

function resolveScale(analysis) {
  const s = analysis.scale
  if (s?.pixelsPerMeter > 1 && (s.confidence ?? 0) >= 0.5) return s.pixelsPerMeter
  // Fallback 1: derive from a labeled dimension
  for (const d of analysis.dimensions || []) {
    if (d?.value > 0 && d.startPixel && d.endPixel) {
      const px = Math.hypot(d.endPixel.x - d.startPixel.x, d.endPixel.y - d.startPixel.y)
      const meters = d.unit === 'mm' ? d.value / 1000 : d.unit === 'cm' ? d.value / 100 : d.unit === 'ft' ? d.value * 0.3048 : d.value
      if (px > 10 && meters > 0.5) return px / meters
    }
  }
  // Fallback 2: standard door width. Detections include specks and partial
  // gaps below the real door sizes, so keep the upper cluster (≥40% of the
  // widest) and read high in it — real hinged doors dominate that range.
  const widths = (analysis.doors || []).map((d) => d?.width).filter((w) => w > 5).sort((a, b) => a - b)
  if (widths.length) {
    const top = widths.filter((w) => w >= widths[widths.length - 1] * 0.4 && w >= 18)
    const use = top.length ? top : widths
    return use[Math.min(use.length - 1, Math.floor(use.length * 0.7))] / 0.9
  }
  // Fallback 3: assume the drawing spans ~14 m
  const size = analysis.imageSize || guessImageSize(analysis)
  return Math.max(size.width, size.height) / 14
}

// Sanity-check a resolved scale against things whose real size is known:
// doors are 0.7–1.1 m in any real building, and interior plans span a few
// meters to a few tens of meters. A wrong unit (mm read as m) or a misread
// dimension makes every downstream step wrong, so catch it here.
function crossCheckScale(ppm, analysis) {
  const labelConfidence = analysis.scale?.source === 'dimension_label' ? (analysis.scale?.confidence ?? 0) : 0
  const doorPx = (analysis.doors || [])
    .map((d) => d?.width)
    .filter((w) => w > 3)
    .sort((a, b) => a - b)
  if (doorPx.length >= 2 && labelConfidence < 0.75) {
    const medianPx = doorPx[Math.floor(doorPx.length / 2)]
    const doorMeters = medianPx / ppm
    if (doorMeters < 0.45 || doorMeters > 2.2) ppm = medianPx / 0.9
  }
  // Extent guard: whatever the source claimed, a floor plan is not 3 m or 150 m across.
  let span = 0
  for (const w of analysis.walls || []) {
    if (w?.start && w?.end) span = Math.max(span, Math.abs(w.end.x - w.start.x), Math.abs(w.end.y - w.start.y))
  }
  if (span > 0) {
    const meters = span / ppm
    if (meters > 100 || meters < 2.5) ppm = span / 14
  }
  return ppm
}

function guessImageSize(analysis) {
  let maxX = 800, maxY = 600
  for (const w of analysis.walls || []) {
    for (const p of [w.start, w.end]) {
      if (!p) continue
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  }
  return { width: maxX, height: maxY }
}

function siteAnalysisToScenePlan(analysis) {
  const ppm = resolveScale(analysis)
  const size = analysis.imageSize || { width: 800, height: 600 }
  const cx = size.width / 2
  const cy = size.height / 2
  const toWorld = (p) => ({ x: (p.x - cx) / ppm, z: (p.y - cy) / ppm })

  let boundary = (analysis.siteBoundary || []).map(toWorld)
  if (boundary.length < 3) {
    // Degenerate output — fall back to a plausible rectangle
    boundary = [
      { x: -15, z: -20 }, { x: 15, z: -20 }, { x: 15, z: 20 }, { x: -15, z: 20 },
    ]
  }
  let area = Math.abs(shoelace(boundary))
  // Trust a printed area label over pixel-derived scale: rescale to match.
  if (analysis.siteArea > 10 && area > 1) {
    const k = Math.sqrt(analysis.siteArea / area)
    boundary = boundary.map((p) => ({ x: p.x * k, z: p.z * k }))
    area = analysis.siteArea
  }
  const roadEdge = analysis.roadSide?.start && analysis.roadSide?.end
    ? { start: toWorld(analysis.roadSide.start), end: toWorld(analysis.roadSide.end) }
    : null

  return finalizeSitePlan({
    planType: 'site',
    name: analysis.planName || 'Site plan',
    site: { boundary, areaM2: area, roadEdge },
    scaleInfo: { pixelsPerMeter: ppm, confidence: analysis.scale?.confidence ?? 0.5, source: analysis.scale?.source || 'estimated' },
  })
}

// ---------------------------------------------------------------------------
// Wall cleanup
// ---------------------------------------------------------------------------

function axisAlign(walls) {
  // Snap nearly-horizontal/vertical walls exactly onto axis — plans are drawn
  // orthogonally and the model's pixel estimates jitter by a few px.
  for (const w of walls) {
    const dx = Math.abs(w.end.x - w.start.x)
    const dz = Math.abs(w.end.z - w.start.z)
    if (dz > 0 && dz < dx * 0.07) {
      const z = (w.start.z + w.end.z) / 2
      w.start.z = z; w.end.z = z
    } else if (dx > 0 && dx < dz * 0.07) {
      const x = (w.start.x + w.end.x) / 2
      w.start.x = x; w.end.x = x
    }
  }
  return walls
}

function snapEndpoints(walls, radius) {
  const points = []
  for (const w of walls) for (const key of ['start', 'end']) points.push({ w, key, p: w[key] })
  const clusters = []
  for (const pt of points) {
    let found = null
    for (const c of clusters) if (dist2d(c.centroid, pt.p) < radius) { found = c; break }
    if (found) {
      found.members.push(pt)
      const n = found.members.length
      found.centroid = {
        x: found.centroid.x + (pt.p.x - found.centroid.x) / n,
        z: found.centroid.z + (pt.p.z - found.centroid.z) / n,
      }
    } else clusters.push({ centroid: { ...pt.p }, members: [pt] })
  }
  for (const c of clusters) for (const m of c.members) m.w[m.key] = { ...c.centroid }
  return walls.filter((w) => dist2d(w.start, w.end) > 0.25)
}

function mergeDuplicateWalls(walls, tolerance) {
  const out = []
  for (const w of walls) {
    const dup = out.find(
      (o) =>
        (dist2d(o.start, w.start) < tolerance && dist2d(o.end, w.end) < tolerance) ||
        (dist2d(o.start, w.end) < tolerance && dist2d(o.end, w.start) < tolerance)
    )
    if (dup) {
      dup.thickness = Math.max(dup.thickness, w.thickness)
      dup.isExterior = dup.isExterior || w.isExterior
    } else out.push(w)
  }
  return out
}

// Vision models often trace both faces of one wall as two parallel segments,
// or break one straight wall into overlapping pieces. Merge segments that lie
// on the same (axis-aligned) line and overlap — but never bridge a real gap,
// which is how open doorways between collinear wall pieces are drawn.
function mergeCollinearOverlaps(walls) {
  const MAX_GAP = 0.05 // merge only touching/overlapping spans, never doorway gaps
  const LINE_TOL = 0.18 // same-line tolerance: double-traced faces sit ~1 thickness apart
  const groups = { h: new Map(), v: new Map() }
  const out = []
  for (const w of walls) {
    const horizontal = Math.abs(w.end.z - w.start.z) < 1e-6
    const vertical = Math.abs(w.end.x - w.start.x) < 1e-6
    if (!horizontal && !vertical) { out.push(w); continue } // diagonal: leave alone
    const axis = horizontal ? 'h' : 'v'
    const offset = horizontal ? w.start.z : w.start.x
    const a = horizontal ? Math.min(w.start.x, w.end.x) : Math.min(w.start.z, w.end.z)
    const b = horizontal ? Math.max(w.start.x, w.end.x) : Math.max(w.start.z, w.end.z)
    let bucket = null
    for (const [key, list] of groups[axis]) {
      if (Math.abs(key - offset) < LINE_TOL) { bucket = list; break }
    }
    if (!bucket) { bucket = []; groups[axis].set(offset, bucket) }
    bucket.push({ w, offset, a, b })
  }
  for (const axis of ['h', 'v']) {
    for (const bucket of groups[axis].values()) {
      bucket.sort((p, q) => p.a - q.a)
      let cur = null
      const flush = () => {
        if (!cur) return
        const w = cur.w
        const off = cur.offset
        if (axis === 'h') {
          w.start = { x: cur.a, z: off }; w.end = { x: cur.b, z: off }
        } else {
          w.start = { x: off, z: cur.a }; w.end = { x: off, z: cur.b }
        }
        out.push(w)
      }
      for (const seg of bucket) {
        if (cur && seg.a <= cur.b + MAX_GAP) {
          cur.b = Math.max(cur.b, seg.b)
          cur.offset = (cur.offset * cur.n + seg.offset) / (cur.n + 1)
          cur.n++
          cur.w.thickness = Math.max(cur.w.thickness, seg.w.thickness)
          cur.w.isExterior = cur.w.isExterior || seg.w.isExterior
        } else {
          flush()
          cur = { ...seg, n: 1 }
        }
      }
      flush()
    }
  }
  return out
}

// A wall whose endpoint stops just short of another wall's body (a slightly
// missed T-junction) leaves a pixel-scale gap the room flood fill leaks
// through, silently merging two rooms. Extend such endpoints onto the wall
// they nearly touch.
function snapTJunctions(walls, radius) {
  for (const w of walls) {
    for (const key of ['start', 'end']) {
      const p = w[key]
      let best = null
      for (const other of walls) {
        if (other === w) continue
        const { t, d } = projectOnSegment(p, other.start, other.end)
        const len = dist2d(other.start, other.end)
        // only true T-junctions: the projection lands on the body, not at a
        // corner (corner gaps were already handled by snapEndpoints)
        if (t * len < 0.15 || (1 - t) * len < 0.15) continue
        if (d < radius + other.thickness / 2 && (!best || d < best.d)) {
          const proj = {
            x: other.start.x + (other.end.x - other.start.x) * t,
            z: other.start.z + (other.end.z - other.start.z) * t,
          }
          best = { d, proj }
        }
      }
      if (best && best.d > 1e-4) w[key] = best.proj
    }
  }
  return walls
}

// Bridge modest gaps between dangling wall endpoints. The model traces
// exterior walls but leaves door/window/balcony openings as bare gaps (it
// never saw wall there) — and unlike an interior doorway (where the full wall
// is still rasterized, keeping rooms apart), an unsealed gap in the outer
// envelope lets the room flood-fill leak "outside" and swallow the whole
// interior. Any two free endpoints (from different walls) within a modest
// distance are almost always one wall broken by an opening; connect them.
// Orientation-agnostic, so it also seals angled bay/balcony walls. Wide gaps
// (open-plan sides, real archways) exceed maxGap and are left open.
function sealCollinearGaps(walls, maxGap = 2.4) {
  const isFree = (p, self) =>
    !walls.some((o) => o !== self && projectOnSegment(p, o.start, o.end).d < o.thickness / 2 + 0.18)
  // collect every dangling endpoint, tagged with its wall's outward direction
  // (the unit vector pointing from the wall INTO the gap, i.e. away from the
  // wall's far end)
  const ends = []
  walls.forEach((w, i) => {
    const len = dist2d(w.start, w.end) || 1
    for (const key of ['start', 'end']) {
      if (!isFree(w[key], w)) continue
      const far = key === 'start' ? w.end : w.start
      ends.push({ wi: i, p: w[key], w, dir: { x: (w[key].x - far.x) / len, z: (w[key].z - far.z) / len } })
    }
  })
  // candidate bridges: two free endpoints of different walls, close enough,
  // where the gap continues at least one wall's own line — the bridge is
  // nearly parallel to that wall AND points outward from it (so we extend a
  // broken wall along itself, never join a corner to an unrelated stub).
  const cand = []
  for (let a = 0; a < ends.length; a++) {
    for (let b = a + 1; b < ends.length; b++) {
      if (ends[a].wi === ends[b].wi) continue
      const gap = dist2d(ends[a].p, ends[b].p)
      if (gap < 0.05 || gap > maxGap) continue
      const ux = (ends[b].p.x - ends[a].p.x) / gap
      const uz = (ends[b].p.z - ends[a].p.z) / gap
      // a→b should run outward along a's line, or b→a along b's line
      const alignA = ends[a].dir.x * ux + ends[a].dir.z * uz
      const alignB = ends[b].dir.x * -ux + ends[b].dir.z * -uz
      if (Math.max(alignA, alignB) < 0.94) continue // ~20° tolerance
      cand.push({ a, b, gap })
    }
  }
  cand.sort((x, y) => x.gap - y.gap)
  const usedEnd = new Set()
  const added = []
  for (const { a, b } of cand) {
    if (usedEnd.has(a) || usedEnd.has(b)) continue
    usedEnd.add(a)
    usedEnd.add(b)
    added.push({
      id: uid('wall'),
      start: { ...ends[a].p },
      end: { ...ends[b].p },
      height: WALL_HEIGHT,
      thickness: Math.max(ends[a].w.thickness, ends[b].w.thickness),
      isExterior: ends[a].w.isExterior || ends[b].w.isExterior,
      openings: [],
      sealed: true,
    })
  }
  return walls.concat(added)
}

// Furniture outlines, dimension lines and railings misread as walls show up
// as short segments floating in space. Real walls connect: prune segments
// with free ends, iterating because removing one orphan can orphan another.
// (A genuine partial wall — a kitchen peninsula, an entry stub — keeps one
// end attached to the rest of the structure and survives.)
function pruneOrphanWalls(walls) {
  const touches = (p, list, self) =>
    list.some((o) => o !== self && projectOnSegment(p, o.start, o.end).d < o.thickness / 2 + 0.22)
  let changed = true
  while (changed) {
    changed = false
    for (let i = walls.length - 1; i >= 0; i--) {
      const w = walls[i]
      const len = dist2d(w.start, w.end)
      const freeEnds =
        (touches(w.start, walls, w) ? 0 : 1) + (touches(w.end, walls, w) ? 0 : 1)
      if ((freeEnds === 2 && len < 2.2) || (freeEnds >= 1 && len < 0.45)) {
        walls.splice(i, 1)
        changed = true
      }
    }
  }
  return walls
}

// How much does this plan's geometry look like a building? Used to arbitrate
// between the neural net's extraction and Claude's when both are available.
// Coverage: enclosed room area over the footprint bbox — fragmented or leaky
// walls enclose little. Free ends: dangling wall endpoints are furniture/
// noise misread as walls — penalize their share.
export function geometryQuality(plan) {
  if (!plan?.rooms?.length || !plan?.walls?.length) return 0
  const bbox = (plan.bounds.maxX - plan.bounds.minX) * (plan.bounds.maxZ - plan.bounds.minZ)
  if (!(bbox > 1)) return 0
  const enclosed = plan.rooms.reduce((s, r) => s + (r.area || 0), 0)
  let ends = 0
  let freeEnds = 0
  for (const w of plan.walls) {
    for (const key of ['start', 'end']) {
      ends++
      const p = w[key]
      const connected = plan.walls.some(
        (o) => o !== w && projectOnSegment(p, o.start, o.end).d < o.thickness / 2 + 0.25
      )
      if (!connected) freeEnds++
    }
  }
  return Math.min(1, enclosed / bbox) * (1 - 0.7 * (freeEnds / Math.max(1, ends)))
}

// Guarantee every non-window opening is physically walkable: the player
// capsule needs clearance past both jambs, whose collision includes half the
// wall thickness. Undersized detections (or undersized real doors) get
// widened to the minimum passable width.
function enforcePassableOpenings(walls) {
  for (const w of walls) {
    const len = dist2d(w.start, w.end)
    for (const o of w.openings) {
      if (o.type === 'window') continue
      const passable = 2 * (PLAYER_RADIUS + w.thickness / 2) + 0.16
      const byType = o.type === 'door' ? 0.8 : 0.95
      o.width = Math.min(Math.max(o.width, byType, passable), Math.max(0.62, len - 0.2))
      const half = o.width / 2 + 0.05
      o.position = clamp(o.position, half, Math.max(half, len - half))
    }
  }
}

function attachOpening(walls, point, opening) {
  let best = null
  for (const w of walls) {
    const { t, d } = projectOnSegment(point, w.start, w.end)
    if (!best || d < best.d) best = { w, t, d }
  }
  if (!best || best.d > 1.0) return // nothing sensible nearby
  const len = dist2d(best.w.start, best.w.end)
  const half = opening.width / 2 + 0.05
  const pos = clamp(best.t * len, half, Math.max(half, len - half))
  if (opening.width > len - 0.15) opening.width = Math.max(0.6, len - 0.3)
  // Reject overlapping openings on the same wall
  for (const o of best.w.openings) {
    if (Math.abs(o.position - pos) < (o.width + opening.width) / 2 + 0.1) return
  }
  best.w.openings.push({ id: uid('open'), ...opening, position: pos })
}

function projectOnSegment(p, a, b) {
  const abx = b.x - a.x, abz = b.z - a.z
  const lenSq = abx * abx + abz * abz || 1e-9
  const t = clamp(((p.x - a.x) * abx + (p.z - a.z) * abz) / lenSq, 0, 1)
  const proj = { x: a.x + abx * t, z: a.z + abz * t }
  return { t, d: dist2d(p, proj) }
}

// ---------------------------------------------------------------------------
// Room reconstruction via grid flood fill
// ---------------------------------------------------------------------------

export function finalizeInteriorPlan(partial) {
  const walls = partial.walls
  const bounds = wallBounds(walls)
  const grid = buildGrid(walls, bounds)

  // Multi-source flood: room seeds (label i) and the outside (label -2)
  // compete for the interior in one breadth-first pass. Whichever source
  // reaches a cell first (by wall-free path distance) claims it. This is the
  // load-bearing robustness trick: if the model leaves a gap in the exterior
  // envelope (an undetected wall at a door, window or balcony opening), the
  // outside can only creep in as far as the nearest room seed — it wins the
  // cells around the leak, not the entire interior. A single missing wall
  // therefore shaves a room instead of turning the whole plan into void.
  const rooms = [...(partial.rooms || [])]
  const queue = []
  let head = 0
  rooms.forEach((room, i) => {
    const c = worldToCell(grid, room.center.x, room.center.z)
    const seed = findNearest(grid, c.cx, c.cy, (v) => v === -3, 12)
    if (seed) {
      grid.cells[seed.y * grid.w + seed.x] = i
      queue.push(seed.y * grid.w + seed.x)
    }
  })
  const pushOutside = (x, y) => {
    if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) return
    const idx = y * grid.w + x
    if (grid.cells[idx] === -3) { grid.cells[idx] = -2; queue.push(idx) }
  }
  for (let x = 0; x < grid.w; x++) { pushOutside(x, 0); pushOutside(x, grid.h - 1) }
  for (let y = 0; y < grid.h; y++) { pushOutside(0, y); pushOutside(grid.w - 1, y) }
  while (head < queue.length) {
    const idx = queue[head++]
    const label = grid.cells[idx]
    const x = idx % grid.w, y = (idx / grid.w) | 0
    const spread = (nx, ny) => {
      if (nx < 0 || ny < 0 || nx >= grid.w || ny >= grid.h) return
      const nidx = ny * grid.w + nx
      if (grid.cells[nidx] === -3) { grid.cells[nidx] = label; queue.push(nidx) }
    }
    spread(x - 1, y); spread(x + 1, y); spread(x, y - 1); spread(x, y + 1)
  }

  // Any remaining enclosed cells are rooms the analyzer missed → synthesize
  for (let y = 1; y < grid.h - 1; y++) {
    for (let x = 1; x < grid.w - 1; x++) {
      if (grid.cells[y * grid.w + x] === -3) {
        const idx = rooms.length
        const size = floodFrom(grid, x, y, idx, (v) => v === -3)
        if (size * CELL * CELL < 1.0) {
          // Too small to be a room — treat as wall cavity
          replaceRegion(grid, idx, -1)
        } else {
          rooms.push({
            id: uid('room'),
            name: `Room ${idx + 1}`, // renamed below once its shape is known
            type: partial.planType === 'office' ? 'office' : 'hall',
            center: { x: 0, z: 0 },
            synthetic: true,
          })
        }
      }
    }
  }

  // Per-room stats + floor rects from the grid
  const stats = rooms.map(() => ({ count: 0, sx: 0, sz: 0, minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }))
  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < grid.w; x++) {
      const v = grid.cells[y * grid.w + x]
      if (v >= 0 && v < stats.length) {
        const s = stats[v]
        const wx = grid.originX + (x + 0.5) * CELL
        const wz = grid.originZ + (y + 0.5) * CELL
        s.count++; s.sx += wx; s.sz += wz
        s.minX = Math.min(s.minX, wx - CELL / 2); s.maxX = Math.max(s.maxX, wx + CELL / 2)
        s.minZ = Math.min(s.minZ, wz - CELL / 2); s.maxZ = Math.max(s.maxZ, wz + CELL / 2)
      }
    }
  }
  const finalRooms = []
  rooms.forEach((room, i) => {
    const s = stats[i]
    if (s.count === 0) return
    const area = s.count * CELL * CELL
    let { name, type } = room
    if (room.synthetic) {
      // The analyzer missed this room — guess from its shape rather than
      // shipping "Room N", which reads as "the AI didn't understand your plan".
      const w = s.maxX - s.minX
      const d = s.maxZ - s.minZ
      const aspect = Math.max(w / Math.max(d, 0.1), d / Math.max(w, 0.1))
      if (area < 3) {
        name = 'Storage?'
        type = 'storage'
      } else if (aspect > 2.4 && area < 10) {
        name = 'Hallway?'
        type = 'hall'
      } else {
        name = `Room ${finalRooms.length + 1}`
      }
    }
    finalRooms.push({
      ...room,
      name,
      type,
      area,
      center: { x: s.sx / s.count, z: s.sz / s.count },
      bbox: { minX: s.minX, maxX: s.maxX, minZ: s.minZ, maxZ: s.maxZ },
      floorRects: regionRects(grid, i),
      gridIndex: i,
    })
  })

  repairRoomAccess(walls, finalRooms, grid)
  markOutdoorRooms(walls, finalRooms, grid)

  const spawn = interiorSpawn(finalRooms, grid)
  return {
    planType: partial.planType,
    name: partial.name,
    walls,
    rooms: finalRooms,
    grid,
    bounds,
    site: null,
    spawn,
    scaleInfo: partial.scaleInfo || { pixelsPerMeter: 1, confidence: 1, source: 'authored' },
  }
}

export function finalizeSitePlan(partial) {
  const boundary = partial.site.boundary
  const areaM2 = partial.site.areaM2 || Math.abs(shoelace(boundary))
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const p of boundary) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z)
  }
  const centroid = polygonCentroid(boundary)
  let spawn = { x: centroid.x, z: centroid.z, angle: 0 }
  const road = partial.site.roadEdge
  if (road) {
    const mid = { x: (road.start.x + road.end.x) / 2, z: (road.start.z + road.end.z) / 2 }
    // Stand 20% in from the road edge, looking across the plot
    spawn = {
      x: mid.x + (centroid.x - mid.x) * 0.2,
      z: mid.z + (centroid.z - mid.z) * 0.2,
      angle: Math.atan2(centroid.x - mid.x, -(centroid.z - mid.z)),
    }
  }
  return {
    planType: 'site',
    name: partial.name,
    walls: [],
    rooms: [],
    grid: null,
    bounds: { minX, maxX, minZ, maxZ },
    site: { ...partial.site, areaM2, centroid },
    spawn,
    scaleInfo: partial.scaleInfo || { pixelsPerMeter: 1, confidence: 1, source: 'authored' },
  }
}

function wallBounds(walls) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const w of walls) {
    for (const p of [w.start, w.end]) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z)
    }
  }
  if (!isFinite(minX)) { minX = -5; maxX = 5; minZ = -5; maxZ = 5 }
  return { minX, maxX, minZ, maxZ }
}

function buildGrid(walls, bounds) {
  const pad = 0.6
  const originX = bounds.minX - pad
  const originZ = bounds.minZ - pad
  const w = Math.ceil((bounds.maxX - bounds.minX + pad * 2) / CELL)
  const h = Math.ceil((bounds.maxZ - bounds.minZ + pad * 2) / CELL)
  const cells = new Int16Array(w * h).fill(-3) // -3 = unknown
  const grid = { originX, originZ, w, h, cell: CELL, cells }
  // Rasterize walls (full rectangles — openings stay blocked so rooms
  // separate at doorways during the fill).
  for (const wall of walls) {
    rasterizeWall(grid, wall)
  }
  return grid
}

function rasterizeWall(grid, wall) {
  const half = wall.thickness / 2 + 0.01
  const len = dist2d(wall.start, wall.end)
  const dx = (wall.end.x - wall.start.x) / len
  const dz = (wall.end.z - wall.start.z) / len
  const steps = Math.ceil(len / (CELL * 0.5))
  for (let i = 0; i <= steps; i++) {
    const px = wall.start.x + dx * (len * i / steps)
    const pz = wall.start.z + dz * (len * i / steps)
    const r = Math.ceil(half / CELL)
    const c = worldToCell(grid, px, pz)
    for (let oy = -r; oy <= r; oy++) {
      for (let ox = -r; ox <= r; ox++) {
        const cx = c.cx + ox, cy = c.cy + oy
        if (cx < 0 || cy < 0 || cx >= grid.w || cy >= grid.h) continue
        const wx = grid.originX + (cx + 0.5) * CELL
        const wz = grid.originZ + (cy + 0.5) * CELL
        // distance from cell center to wall segment
        const { d } = projectOnSegment({ x: wx, z: wz }, wall.start, wall.end)
        if (d <= half) grid.cells[cy * grid.w + cx] = -1
      }
    }
  }
}

function worldToCell(grid, x, z) {
  return {
    cx: Math.floor((x - grid.originX) / grid.cell),
    cy: Math.floor((z - grid.originZ) / grid.cell),
  }
}

function floodFrom(grid, sx, sy, value, canFill) {
  if (sx < 0 || sy < 0 || sx >= grid.w || sy >= grid.h) return 0
  if (!canFill(grid.cells[sy * grid.w + sx])) return 0
  const stack = [sy * grid.w + sx]
  let count = 0
  while (stack.length) {
    const idx = stack.pop()
    if (!canFill(grid.cells[idx])) continue
    grid.cells[idx] = value
    count++
    const x = idx % grid.w, y = (idx / grid.w) | 0
    if (x > 0) stack.push(idx - 1)
    if (x < grid.w - 1) stack.push(idx + 1)
    if (y > 0) stack.push(idx - grid.w)
    if (y < grid.h - 1) stack.push(idx + grid.w)
  }
  return count
}

function replaceRegion(grid, from, to) {
  for (let i = 0; i < grid.cells.length; i++) if (grid.cells[i] === from) grid.cells[i] = to
}

function findNearest(grid, cx, cy, pred, maxR) {
  for (let r = 0; r <= maxR; r++) {
    for (let oy = -r; oy <= r; oy++) {
      for (let ox = -r; ox <= r; ox++) {
        if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue
        const x = cx + ox, y = cy + oy
        if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) continue
        if (pred(grid.cells[y * grid.w + x])) return { x, y }
      }
    }
  }
  return null
}

// Greedy rectangle decomposition of a room's cells → few large floor quads.
function regionRects(grid, region) {
  const used = new Uint8Array(grid.w * grid.h)
  const rects = []
  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < grid.w; x++) {
      const idx = y * grid.w + x
      if (grid.cells[idx] !== region || used[idx]) continue
      // grow right
      let w = 1
      while (x + w < grid.w && grid.cells[idx + w] === region && !used[idx + w]) w++
      // grow down
      let h = 1
      outer: while (y + h < grid.h) {
        for (let i = 0; i < w; i++) {
          const j = (y + h) * grid.w + x + i
          if (grid.cells[j] !== region || used[j]) break outer
        }
        h++
      }
      for (let yy = 0; yy < h; yy++)
        for (let xx = 0; xx < w; xx++) used[(y + yy) * grid.w + x + xx] = 1
      rects.push({
        x: grid.originX + x * CELL,
        z: grid.originZ + y * CELL,
        w: w * CELL,
        d: h * CELL,
      })
    }
  }
  return rects
}

// ---------------------------------------------------------------------------
// Room access repair — a missed door in the analysis means a room you can see
// on the minimap but can never enter. Build the room-connectivity graph from
// the actual door openings; any room unreachable from the spawn room gets a
// doorway punched through its longest shared wall with a reachable region.
// ---------------------------------------------------------------------------

function repairRoomAccess(walls, rooms, grid) {
  if (!rooms.length) return
  const OUTSIDE = -2

  const regionAt = (x, z) => {
    const { cx, cy } = worldToCell(grid, x, z)
    if (cx < 0 || cy < 0 || cx >= grid.w || cy >= grid.h) return OUTSIDE
    return grid.cells[cy * grid.w + cx]
  }
  // Region on each side of a wall at distance `along` from its start. Samples
  // two offsets so a jamb or nearby parallel wall doesn't read as "no room".
  const sideRegions = (wall, along) => {
    const len = dist2d(wall.start, wall.end)
    const ux = (wall.end.x - wall.start.x) / len
    const uz = (wall.end.z - wall.start.z) / len
    const px = wall.start.x + ux * along
    const pz = wall.start.z + uz * along
    const result = []
    for (const sign of [1, -1]) {
      let v = -1
      for (const off of [wall.thickness / 2 + 0.2, wall.thickness / 2 + 0.4]) {
        v = regionAt(px - uz * off * sign, pz + ux * off * sign)
        if (v !== -1) break
      }
      result.push(v)
    }
    return result
  }

  // Connectivity graph from existing door/doorway openings
  const adj = new Map()
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set())
    if (!adj.has(b)) adj.set(b, new Set())
    adj.get(a).add(b)
    adj.get(b).add(a)
  }
  for (const w of walls) {
    for (const o of w.openings) {
      if (o.type === 'window') continue
      const [a, b] = sideRegions(w, o.position)
      if (a !== -1 && b !== -1 && a !== b) link(a, b)
    }
  }

  const spawnRoom = rooms.reduce((p, r) => (r.area > p.area ? r : p))
  const reachable = new Set([spawnRoom.gridIndex])
  const queue = [spawnRoom.gridIndex]
  while (queue.length) {
    for (const n of adj.get(queue.pop()) || []) {
      if (!reachable.has(n)) { reachable.add(n); queue.push(n) }
    }
  }

  const pending = rooms
    .filter((r) => !reachable.has(r.gridIndex))
    .sort((a, b) => b.area - a.area)

  let progress = true
  while (progress && pending.length) {
    progress = false
    for (let i = 0; i < pending.length; i++) {
      const room = pending[i]
      const best = findPunchSite(walls, room.gridIndex, reachable, sideRegions)
      if (!best) continue
      const width = Math.max(0.95, 2 * (PLAYER_RADIUS + best.wall.thickness / 2) + 0.16)
      const len = dist2d(best.wall.start, best.wall.end)
      const half = width / 2 + 0.05
      const position = clamp(best.along, half, Math.max(half, len - half))
      const clash = best.wall.openings.some(
        (o) => Math.abs(o.position - position) < (o.width + width) / 2 + 0.1
      )
      if (!clash) {
        best.wall.openings.push({
          id: uid('open'),
          type: 'doorway',
          width,
          height: 2.05,
          sillHeight: 0,
          position,
          inferred: true,
        })
      }
      reachable.add(room.gridIndex)
      // rooms that were only reachable through this one may now connect
      const q2 = [room.gridIndex]
      while (q2.length) {
        for (const n of adj.get(q2.pop()) || []) {
          if (!reachable.has(n)) { reachable.add(n); q2.push(n) }
        }
      }
      pending.splice(i, 1)
      progress = true
      break
    }
  }
}

// ---------------------------------------------------------------------------
// Outdoor rooms — balconies, terraces, patios are open to the sky: their
// walls against the void are railings, not full walls, and they get no
// ceiling or ceiling fixtures. The 3D layer reads room.outdoor and
// wall.railing to render this.
// ---------------------------------------------------------------------------

const OUTDOOR_ROOM = /balcon|terrace|terrasse|patio|deck|veranda|porch|loggia/i

function markOutdoorRooms(walls, rooms, grid) {
  const outdoorIdx = new Set()
  for (const r of rooms) {
    if (r.type === 'balcony' || OUTDOOR_ROOM.test(r.name || '')) {
      r.outdoor = true
      outdoorIdx.add(r.gridIndex)
    }
  }
  if (!outdoorIdx.size) return
  const regionAt = (x, z) => {
    const { cx, cy } = worldToCell(grid, x, z)
    if (cx < 0 || cy < 0 || cx >= grid.w || cy >= grid.h) return -2
    return grid.cells[cy * grid.w + cx]
  }
  for (const w of walls) {
    const len = dist2d(w.start, w.end)
    if (len < 0.05) continue
    const ux = (w.end.x - w.start.x) / len
    const uz = (w.end.z - w.start.z) / len
    let railing = 0
    let solid = 0
    for (let s = Math.min(0.25, len / 2); s <= len - 0.2; s += 0.35) {
      const px = w.start.x + ux * s
      const pz = w.start.z + uz * s
      const sides = [1, -1].map((sign) => {
        for (const off of [w.thickness / 2 + 0.2, w.thickness / 2 + 0.4]) {
          const v = regionAt(px - uz * off * sign, pz + ux * off * sign)
          if (v !== -1) return v
        }
        return -1
      })
      const out = sides.filter((v) => outdoorIdx.has(v)).length
      const voidSide = sides.filter((v) => v === -2).length
      if ((out === 1 && voidSide === 1) || out === 2) railing++
      else if (sides.some((v) => v >= 0 && !outdoorIdx.has(v))) solid++
    }
    if (railing > 0 && railing >= solid * 2) {
      w.railing = true
      // a parapet has no windows or doors — keep render, collision and
      // minimap consistent by dropping any openings detected in it
      w.openings = []
    }
  }
}

// Ceiling footprint when outdoor rooms exist: every cell that is wall or an
// INDOOR room, greedily decomposed into few large rects (world units).
export function ceilingRects(plan) {
  const grid = plan.grid
  if (!grid) return null
  const outdoor = new Set(plan.rooms.filter((r) => r.outdoor).map((r) => r.gridIndex))
  if (!outdoor.size) return null
  // railing wall cells are open sky too — a 1m parapet has no roof over it
  const railMask = new Uint8Array(grid.w * grid.h)
  for (const wall of plan.walls) {
    if (!wall.railing) continue
    const half = wall.thickness / 2 + 0.02
    const len = dist2d(wall.start, wall.end)
    const steps = Math.max(1, Math.ceil(len / (CELL * 0.5)))
    const r = Math.ceil(half / CELL) + 1
    for (let i = 0; i <= steps; i++) {
      const px = wall.start.x + (wall.end.x - wall.start.x) * (i / steps)
      const pz = wall.start.z + (wall.end.z - wall.start.z) * (i / steps)
      const c = worldToCell(grid, px, pz)
      for (let oy = -r; oy <= r; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          const cx = c.cx + ox, cy = c.cy + oy
          if (cx < 0 || cy < 0 || cx >= grid.w || cy >= grid.h) continue
          const wx = grid.originX + (cx + 0.5) * CELL
          const wz = grid.originZ + (cy + 0.5) * CELL
          if (projectOnSegment({ x: wx, z: wz }, wall.start, wall.end).d <= half) {
            railMask[cy * grid.w + cx] = 1
          }
        }
      }
    }
  }
  const keep = (v, idx) => !railMask[idx] && (v === -1 || (v >= 0 && !outdoor.has(v)))
  const used = new Uint8Array(grid.w * grid.h)
  const rects = []
  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < grid.w; x++) {
      const idx = y * grid.w + x
      if (used[idx] || !keep(grid.cells[idx], idx)) continue
      let w = 1
      while (x + w < grid.w && !used[idx + w] && keep(grid.cells[idx + w], idx + w)) w++
      let h = 1
      outer: while (y + h < grid.h) {
        for (let i = 0; i < w; i++) {
          const j = (y + h) * grid.w + x + i
          if (used[j] || !keep(grid.cells[j], j)) break outer
        }
        h++
      }
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) used[(y + yy) * grid.w + x + xx] = 1
      rects.push({
        x: grid.originX + x * CELL,
        z: grid.originZ + y * CELL,
        w: w * CELL,
        d: h * CELL,
      })
    }
  }
  return rects
}

// Best place to punch a doorway between `region` and any reachable region:
// walk each wall, mark spans where the two sides are exactly that pair, and
// prefer interior neighbors (punching to the outdoors is a last resort).
function findPunchSite(walls, region, reachable, sideRegions) {
  const STEP = 0.15
  let best = null
  for (const wall of walls) {
    const len = dist2d(wall.start, wall.end)
    if (len < 1.0) continue
    let run = null
    const closeRun = () => {
      if (!run) return
      const length = run.end - run.start
      if (length >= 0.9) {
        const interior = run.other >= 0
        const score = length + (interior ? 100 : 0)
        if (!best || score > best.score) {
          best = { wall, along: (run.start + run.end) / 2, score }
        }
      }
      run = null
    }
    for (let s = STEP; s <= len - STEP; s += STEP) {
      const [a, b] = sideRegions(wall, s)
      const pair =
        (a === region && reachable.has(b) && b !== region) ? b
        : (b === region && reachable.has(a) && a !== region) ? a
        : null
      if (pair !== null) {
        if (run && run.other === pair) run.end = s
        else { closeRun(); run = { start: s, end: s, other: pair } }
      } else closeRun()
    }
    closeRun()
  }
  return best
}

function interiorSpawn(rooms, grid) {
  if (!rooms.length) return { x: 0, z: 0, angle: 0 }
  const biggest = rooms.reduce((a, b) => (b.area > a.area ? b : a))
  const c = biggest.center
  const wide = biggest.bbox.maxX - biggest.bbox.minX >= biggest.bbox.maxZ - biggest.bbox.minZ
  const angle = wide ? Math.PI / 2 : 0
  // step back from the room center so the ceiling fixture isn't in your face
  const back = Math.min(
    1.3,
    (wide ? biggest.bbox.maxX - biggest.bbox.minX : biggest.bbox.maxZ - biggest.bbox.minZ) / 4
  )
  return { x: c.x + Math.sin(angle) * back, z: c.z + Math.cos(angle) * back, angle }
}

// Which room contains a world point (null if in wall / outside)
export function roomAt(plan, x, z) {
  if (!plan?.grid) return null
  const { cx, cy } = worldToCell(plan.grid, x, z)
  if (cx < 0 || cy < 0 || cx >= plan.grid.w || cy >= plan.grid.h) return null
  const v = plan.grid.cells[cy * plan.grid.w + cx]
  if (v < 0) return null
  return plan.rooms.find((r) => r.gridIndex === v) || null
}

// ---------------------------------------------------------------------------
// Collision segments (walls minus door openings, plus window sills stay solid)
// ---------------------------------------------------------------------------

export function collisionSegments(plan) {
  const segs = []
  for (const wall of plan.walls || []) {
    const len = dist2d(wall.start, wall.end)
    const dx = (wall.end.x - wall.start.x) / len
    const dz = (wall.end.z - wall.start.z) / len
    const half = wall.thickness / 2
    const doorGaps = wall.openings
      .filter((o) => o.type !== 'window')
      .map((o) => [o.position - o.width / 2, o.position + o.width / 2])
      .sort((a, b) => a[0] - b[0])
    let cursor = 0
    const spans = []
    for (const [a, b] of doorGaps) {
      if (a > cursor) spans.push([cursor, a])
      cursor = Math.max(cursor, b)
    }
    if (cursor < len) spans.push([cursor, len])
    for (const [a, b] of spans) {
      if (b - a < 0.02) continue
      segs.push({
        ax: wall.start.x + dx * a, az: wall.start.z + dz * a,
        bx: wall.start.x + dx * b, bz: wall.start.z + dz * b,
        r: half,
      })
    }
  }
  return segs
}

function shoelace(poly) {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    s += a.x * b.z - b.x * a.z
  }
  return s / 2
}

function polygonCentroid(poly) {
  let sx = 0, sz = 0
  for (const p of poly) { sx += p.x; sz += p.z }
  return { x: sx / poly.length, z: sz / poly.length }
}

export function pointInPolygon(p, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
