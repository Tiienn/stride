// Segmentation mask → analyzer-schema JSON (walls/doors/windows in pixels).
// JS port of ml/train/vectorize.py — keep the two in sync; the Python one is
// diff-tested against this in CI-ish smoke tests.
//
// classMask: Uint8Array/Int array, h*w, values 0 bg / 1 wall / 2 door / 3 window.

export function maskToAnalysis(classMask, w, h) {
  const solid = new Uint8Array(w * h)
  for (let i = 0; i < classMask.length; i++) solid[i] = classMask[i] > 0 ? 1 : 0
  const minLen = Math.max(12, Math.floor(Math.min(h, w) * 0.03))
  let walls = wallSegments(solid, w, h, minLen)

  // Thickness filter: furniture outlines and dimension lines misclassified
  // as wall are a few px thick; real walls cluster near a dominant thickness.
  // Length-weighted median gives that dominant value robustly.
  const weighted = []
  for (const wall of walls) {
    const len = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y)
    weighted.push({ t: wall.thickness, len })
  }
  weighted.sort((a, b) => a.t - b.t)
  const totalLen = weighted.reduce((s, e) => s + e.len, 0)
  let acc = 0
  let domThick = 8
  for (const e of weighted) {
    acc += e.len
    if (acc >= totalLen / 2) { domThick = e.t; break }
  }
  walls = walls.filter((wall) => wall.thickness >= Math.max(3.5, domThick * 0.45))

  // exterior = near the wall-pixel bounding box border
  let bx0 = w, bx1 = 0, by0 = h, by1 = 0, any = false
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (solid[y * w + x]) {
        any = true
        if (x < bx0) bx0 = x
        if (x > bx1) bx1 = x
        if (y < by0) by0 = y
        if (y > by1) by1 = y
      }
    }
  }
  if (any) {
    const mx = (bx1 - bx0) * 0.08
    const my = (by1 - by0) * 0.08
    for (const wall of walls) {
      const { start: s, end: e } = wall
      if ((Math.abs(s.y - by0) < my && Math.abs(e.y - by0) < my) ||
          (Math.abs(s.y - by1) < my && Math.abs(e.y - by1) < my) ||
          (Math.abs(s.x - bx0) < mx && Math.abs(e.x - bx0) < mx) ||
          (Math.abs(s.x - bx1) < mx && Math.abs(e.x - bx1) < mx)) {
        wall.isExterior = true
      }
    }
  }

  // opening speck filter: real doors are wider than ~1.2 wall thicknesses
  const thicknesses = walls.map((x) => x.thickness).sort((a, b) => a - b)
  const medThick = thicknesses.length ? thicknesses[Math.floor(thicknesses.length / 2)] : 8
  const minOpen = Math.max(16, medThick * 1.2)

  const doors = openings(classMask, w, h, 2).filter((o) => o.width >= minOpen)
    .map((o) => ({ ...o, kind: 'hinged' }))
  const windows = openings(classMask, w, h, 3).filter((o) => o.width >= minOpen * 0.6)

  return {
    planType: 'floor_residential',
    planName: 'Uploaded plan',
    confidence: 0.9,
    imageSize: { width: w, height: h },
    walls,
    doors,
    windows,
    rooms: [], // planProcess flood-fill synthesizes them from the walls
    scale: { pixelsPerMeter: 0, confidence: 0, source: 'door_width' },
  }
}

// Morphological opening with a 1xN kernel via run-length checks: keep only
// pixels inside runs >= length along the given direction.
function openDirectional(binary, w, h, length, horizontal) {
  const out = new Uint8Array(w * h)
  const outer = horizontal ? h : w
  const inner = horizontal ? w : h
  for (let o = 0; o < outer; o++) {
    let runStart = -1
    for (let i = 0; i <= inner; i++) {
      const idx = horizontal ? o * w + i : i * w + o
      const v = i < inner ? binary[idx] : 0
      if (v && runStart < 0) runStart = i
      else if (!v && runStart >= 0) {
        if (i - runStart >= length) {
          for (let j = runStart; j < i; j++) out[horizontal ? o * w + j : j * w + o] = 1
        }
        runStart = -1
      }
    }
  }
  return out
}

function components(binary, w, h) {
  const labels = new Int32Array(w * h)
  let count = 0
  const stack = []
  for (let start = 0; start < w * h; start++) {
    if (!binary[start] || labels[start]) continue
    count++
    labels[start] = count
    stack.length = 0
    stack.push(start)
    while (stack.length) {
      const idx = stack.pop()
      const x = idx % w
      const y = (idx / w) | 0
      if (x > 0 && binary[idx - 1] && !labels[idx - 1]) { labels[idx - 1] = count; stack.push(idx - 1) }
      if (x < w - 1 && binary[idx + 1] && !labels[idx + 1]) { labels[idx + 1] = count; stack.push(idx + 1) }
      if (y > 0 && binary[idx - w] && !labels[idx - w]) { labels[idx - w] = count; stack.push(idx - w) }
      if (y < h - 1 && binary[idx + w] && !labels[idx + w]) { labels[idx + w] = count; stack.push(idx + w) }
    }
  }
  return { labels, count }
}

function wallSegments(solid, w, h, minLen) {
  const walls = []
  for (const horizontal of [true, false]) {
    const directional = openDirectional(solid, w, h, minLen, horizontal)
    const { labels, count } = components(directional, w, h)
    const stats = new Array(count + 1)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = labels[y * w + x]
        if (!c) continue
        let s = stats[c]
        if (!s) s = stats[c] = { n: 0, sx: 0, sy: 0, x0: x, x1: x, y0: y, y1: y }
        s.n++
        s.sx += x
        s.sy += y
        if (x < s.x0) s.x0 = x
        if (x > s.x1) s.x1 = x
        if (y < s.y0) s.y0 = y
        if (y > s.y1) s.y1 = y
      }
    }
    for (let c = 1; c <= count; c++) {
      const s = stats[c]
      if (!s || s.n < minLen) continue
      if (horizontal) {
        const thickness = Math.max(1, s.n / Math.max(1, s.x1 - s.x0 + 1))
        const cy = s.sy / s.n
        walls.push({
          start: { x: s.x0, y: cy }, end: { x: s.x1, y: cy },
          thickness, isExterior: false,
        })
      } else {
        const thickness = Math.max(1, s.n / Math.max(1, s.y1 - s.y0 + 1))
        const cx = s.sx / s.n
        walls.push({
          start: { x: cx, y: s.y0 }, end: { x: cx, y: s.y1 },
          thickness, isExterior: false,
        })
      }
    }
  }
  return walls
}

function openings(classMask, w, h, cls, minPx = 4) {
  const binary = new Uint8Array(w * h)
  for (let i = 0; i < classMask.length; i++) binary[i] = classMask[i] === cls ? 1 : 0
  const { labels, count } = components(binary, w, h)
  const stats = new Array(count + 1)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = labels[y * w + x]
      if (!c) continue
      let s = stats[c]
      if (!s) s = stats[c] = { n: 0, sx: 0, sy: 0, x0: x, x1: x, y0: y, y1: y }
      s.n++
      s.sx += x
      s.sy += y
      if (x < s.x0) s.x0 = x
      if (x > s.x1) s.x1 = x
      if (y < s.y0) s.y0 = y
      if (y > s.y1) s.y1 = y
    }
  }
  const out = []
  for (let c = 1; c <= count; c++) {
    const s = stats[c]
    if (!s || s.n < minPx * minPx) continue
    out.push({
      center: { x: s.sx / s.n, y: s.sy / s.n },
      width: Math.max(s.x1 - s.x0 + 1, s.y1 - s.y0 + 1),
    })
  }
  return out
}
