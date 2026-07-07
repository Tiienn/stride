#!/usr/bin/env node
// Synthetic floor-plan generator for training a specialized plan-recognition
// model. Produces, per sample:
//   img_NNNNN.png  — a stylized architectural drawing (randomized style)
//   msk_NNNNN.png  — pixel-perfect class mask (bg/wall/door/window)
//   gt_NNNNN.json  — ground truth in the same schema Stride's Claude analyzer
//                    emits, so model output can flow into planProcess.js
//
// Usage: node ml/generate.mjs --count 1000 --out ml/data/train --seed 1
//
// The layout is generated in METERS (BSP splits of a rectangular footprint,
// doors placed on a spanning tree of the room-adjacency graph so every plan
// is fully walkable), then rendered to pixels at a random scale. Style — wall
// fills, door arcs, fonts, dimension lines, furniture distractors, paper
// grids — is randomized per sample so the model learns geometry, not style.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

// ---------------------------------------------------------------------------
// CLI + RNG
// ---------------------------------------------------------------------------

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ') || true] })
)
const COUNT = parseInt(args.count || '20', 10)
const OUT = args.out || 'ml/data/train'
const SEED = parseInt(args.seed || '1', 10)
const START = parseInt(args.start || '0', 10) // global sample index this process starts at
// @resvg/resvg-js (2.6.2) leaks native memory on every Resvg instantiation —
// confirmed ~2.7MB/call, unbounded, regardless of font-loading options. Left
// unchecked, generating 10k samples in one process grows to >25GB RSS and
// gets OOM-killed partway through (exactly what silently truncated a run on
// Colab's free-tier VM). Below this chunk size, this process renders
// in-process; above it, it becomes a driver that restarts itself in a fresh
// subprocess every CHUNK samples so the OS reclaims the leak on each exit.
const CHUNK = parseInt(args.chunk || '400', 10)

// Cheap, explicit font files instead of loadSystemFonts: true — that option
// rescans every font on the system on every single call, which is wasted
// work at this scale even though it isn't the source of the leak above.
const FONT_FILES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
].filter(existsSync)
const RESVG_OPTS = FONT_FILES.length
  ? { font: { loadSystemFonts: false, fontFiles: FONT_FILES, defaultFontFamily: 'DejaVu Sans' } }
  : { font: { loadSystemFonts: true } } // fallback for systems without these exact paths

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
let rng = mulberry32(SEED)
const rand = (a, b) => a + rng() * (b - a)
const randi = (a, b) => Math.floor(rand(a, b + 1))
const pick = (arr) => arr[Math.floor(rng() * arr.length)]
const chance = (p) => rng() < p

// ---------------------------------------------------------------------------
// Layout generation (meters)
// ---------------------------------------------------------------------------

const MIN_ROOM = 2.0 // no BSP split may produce a room narrower than this

function generateLayout() {
  const W = rand(8, 18)
  const H = rand(6, 14)
  const targetRooms = randi(3, 9)

  // BSP: repeatedly split the largest splittable leaf
  let leaves = [{ x: 0, y: 0, w: W, h: H }]
  const partitions = [] // interior walls: {axis:'v'|'h', c, a0, a1}
  while (leaves.length < targetRooms) {
    leaves.sort((p, q) => q.w * q.h - p.w * p.h)
    const r = leaves.find((l) => Math.max(l.w, l.h) > MIN_ROOM * 2.2)
    if (!r) break
    leaves = leaves.filter((l) => l !== r)
    const vertical = r.w === Math.max(r.w, r.h) ? !chance(0.15) : chance(0.15)
    if (vertical) {
      const c = r.x + r.w * rand(0.35, 0.65)
      partitions.push({ axis: 'v', c, a0: r.y, a1: r.y + r.h })
      leaves.push({ x: r.x, y: r.y, w: c - r.x, h: r.h })
      leaves.push({ x: c, y: r.y, w: r.x + r.w - c, h: r.h })
    } else {
      const c = r.y + r.h * rand(0.35, 0.65)
      partitions.push({ axis: 'h', c, a0: r.x, a1: r.x + r.w })
      leaves.push({ x: r.x, y: r.y, w: r.w, h: c - r.y })
      leaves.push({ x: r.x, y: c, w: r.w, h: r.y + r.h - c })
    }
  }

  // Room adjacency via shared boundaries (for door placement)
  const EPS = 1e-6
  const adjacency = [] // {a, b, axis, c, lo, hi}
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const A = leaves[i], B = leaves[j]
      if (Math.abs(A.x + A.w - B.x) < EPS || Math.abs(B.x + B.w - A.x) < EPS) {
        const c = Math.abs(A.x + A.w - B.x) < EPS ? A.x + A.w : B.x + B.w
        const lo = Math.max(A.y, B.y), hi = Math.min(A.y + A.h, B.y + B.h)
        if (hi - lo > 1.4) adjacency.push({ a: i, b: j, axis: 'v', c, lo, hi })
      }
      if (Math.abs(A.y + A.h - B.y) < EPS || Math.abs(B.y + B.h - A.y) < EPS) {
        const c = Math.abs(A.y + A.h - B.y) < EPS ? A.y + A.h : B.y + B.h
        const lo = Math.max(A.x, B.x), hi = Math.min(A.x + A.w, B.x + B.w)
        if (hi - lo > 1.4) adjacency.push({ a: i, b: j, axis: 'h', c, lo, hi })
      }
    }
  }

  // Open-plan: erase the wall between some adjacent pairs — kitchen flowing
  // into living with no partition, the single most common feature of real
  // plans that fully-partitioned synthetics fail to teach.
  const openGaps = [] // {axis, c, lo, hi} — subtracted from partitions
  const openKeys = new Set()
  if (adjacency.length && chance(0.55)) {
    for (let k = 0; k < randi(1, Math.min(2, adjacency.length)); k++) {
      const e = pick(adjacency)
      const key = `${e.a}-${e.b}`
      if (openKeys.has(key)) continue
      openKeys.add(key)
      openGaps.push({ axis: e.axis, c: e.c, lo: e.lo + rand(0.1, 0.5), hi: e.hi - rand(0.1, 0.5) })
    }
  }

  // Doors on a spanning tree => every room reachable; extras add circulation.
  // Open pairs connect without a door (the wall just isn't there).
  const doors = [] // {axis, c, pos, width, kind}
  const connected = new Set([0])
  const edges = [...adjacency]
  while (connected.size < leaves.length && edges.length) {
    const idx = edges.findIndex((e) => connected.has(e.a) !== connected.has(e.b))
    if (idx === -1) break
    const [e] = edges.splice(idx, 1)
    connected.add(e.a); connected.add(e.b)
    if (!openKeys.has(`${e.a}-${e.b}`)) doors.push(makeDoor(e, false))
  }
  for (const e of edges) {
    if (!openKeys.has(`${e.a}-${e.b}`) && chance(0.15)) doors.push(makeDoor(e, false))
  }

  function makeDoor(e, entrance) {
    const width = entrance ? rand(0.9, 1.1) : rand(0.75, 1.0)
    const pos = rand(e.lo + 0.35 + width / 2, e.hi - 0.35 - width / 2)
    return { axis: e.axis, c: e.c, pos, width, kind: entrance ? 'entrance' : chance(0.12) ? 'doorway' : 'hinged' }
  }

  // Entrance on an exterior edge of some room
  const extRooms = leaves.map((r, i) => ({ r, i })).filter(({ r }) =>
    r.x < EPS || r.y < EPS || Math.abs(r.x + r.w - W) < EPS || Math.abs(r.y + r.h - H) < EPS)
  const ent = pick(extRooms).r
  const sides = []
  if (ent.x < EPS) sides.push({ axis: 'v', c: 0, lo: ent.y, hi: ent.y + ent.h })
  if (Math.abs(ent.x + ent.w - W) < EPS) sides.push({ axis: 'v', c: W, lo: ent.y, hi: ent.y + ent.h })
  if (ent.y < EPS) sides.push({ axis: 'h', c: 0, lo: ent.x, hi: ent.x + ent.w })
  if (Math.abs(ent.y + ent.h - H) < EPS) sides.push({ axis: 'h', c: H, lo: ent.x, hi: ent.x + ent.w })
  const entSide = pick(sides)
  const entranceDoor = makeDoor(entSide, true)
  doors.push(entranceDoor)

  // Windows on exterior edges, clear of the entrance
  const windows = [] // {axis, c, pos, width}
  for (const { r } of extRooms) {
    const spans = []
    if (r.x < EPS) spans.push({ axis: 'v', c: 0, lo: r.y, hi: r.y + r.h })
    if (Math.abs(r.x + r.w - W) < EPS) spans.push({ axis: 'v', c: W, lo: r.y, hi: r.y + r.h })
    if (r.y < EPS) spans.push({ axis: 'h', c: 0, lo: r.x, hi: r.x + r.w })
    if (Math.abs(r.y + r.h - H) < EPS) spans.push({ axis: 'h', c: H, lo: r.x, hi: r.x + r.w })
    for (const s of spans) {
      const n = Math.max(0, Math.floor((s.hi - s.lo) / rand(2.6, 4.5)))
      for (let k = 0; k < n; k++) {
        if (!chance(0.85)) continue
        const width = rand(0.6, Math.min(2.0, (s.hi - s.lo) * 0.4))
        const pos = s.lo + ((k + 0.5) / n) * (s.hi - s.lo) + rand(-0.3, 0.3)
        if (pos - width / 2 < s.lo + 0.3 || pos + width / 2 > s.hi - 0.3) continue
        if (s.axis === entranceDoor.axis && Math.abs(s.c - entranceDoor.c) < EPS &&
            Math.abs(pos - entranceDoor.pos) < (width + entranceDoor.width) / 2 + 0.4) continue
        windows.push({ axis: s.axis, c: s.c, pos, width })
      }
    }
  }

  // Room typing by size + adjacency heuristics, mirroring real apartments
  const order = leaves.map((r, i) => ({ r, i, area: r.w * r.h })).sort((p, q) => q.area - p.area)
  const types = new Array(leaves.length).fill('bedroom')
  types[order[0].i] = 'living'
  if (order.length > 2) types[order[order.length - 1].i] = 'bathroom'
  if (order.length > 3) {
    const kitchen = order.find(({ i }) => i !== order[0].i && types[i] === 'bedroom' &&
      adjacency.some((e) => (e.a === i && e.b === order[0].i) || (e.b === i && e.a === order[0].i)))
    if (kitchen) types[kitchen.i] = 'kitchen'
  }
  leaves.forEach((r, i) => {
    const aspect = Math.max(r.w / r.h, r.h / r.w)
    if (types[i] === 'bedroom' && aspect > 2.6) types[i] = 'hall'
    if (types[i] === 'bedroom' && r.w * r.h < 4.5) types[i] = 'storage'
  })
  let bedN = 0
  const NAMES = { living: 'Living Room', kitchen: 'Kitchen', bathroom: 'Bathroom', hall: 'Hallway', storage: 'Storage' }
  const rooms = leaves.map((r, i) => ({
    ...r,
    type: types[i],
    name: types[i] === 'bedroom' ? `Bedroom ${++bedN}` : NAMES[types[i]],
    area: r.w * r.h,
  }))
  if (bedN === 1) rooms.find((r) => r.name === 'Bedroom 1').name = 'Bedroom'

  // Balcony: a thin-outlined box attached OUTSIDE an exterior wall, reached
  // through a sliding door. Its railing is deliberately NOT a wall in the
  // mask — the model must learn that thin outline boxes aren't structure.
  let balcony = null
  if (chance(0.35)) {
    const br = pick(extRooms).r
    const bsides = []
    if (br.x < EPS) bsides.push({ axis: 'v', c: 0, lo: br.y, hi: br.y + br.h, out: -1 })
    if (Math.abs(br.x + br.w - W) < EPS) bsides.push({ axis: 'v', c: W, lo: br.y, hi: br.y + br.h, out: 1 })
    if (br.y < EPS) bsides.push({ axis: 'h', c: 0, lo: br.x, hi: br.x + br.w, out: -1 })
    if (Math.abs(br.y + br.h - H) < EPS) bsides.push({ axis: 'h', c: H, lo: br.x, hi: br.x + br.w, out: 1 })
    const s = bsides.length ? pick(bsides) : null
    if (s && s.hi - s.lo > 2.6) {
      const bw = Math.min(rand(2.2, 4.2), s.hi - s.lo - 0.6)
      const lo = rand(s.lo + 0.3, s.hi - 0.3 - bw)
      balcony = { axis: s.axis, c: s.c, lo, hi: lo + bw, depth: rand(1.2, 2.2), out: s.out }
      const slider = { axis: s.axis, c: s.c, pos: lo + bw / 2, width: Math.min(rand(1.4, 2.2), bw - 0.5), kind: 'sliding' }
      doors.push(slider)
      // windows were placed before the balcony existed — clear the slider's span
      for (let i = windows.length - 1; i >= 0; i--) {
        const win = windows[i]
        if (win.axis === slider.axis && Math.abs(win.c - slider.c) < EPS &&
            Math.abs(win.pos - slider.pos) < (win.width + slider.width) / 2 + 0.4) windows.splice(i, 1)
      }
    }
  }

  return {
    W, H, rooms, doors, windows, openGaps, balcony,
    extThick: rand(0.24, 0.4),
    intThick: rand(0.09, 0.16),
    partitions,
  }
}

// ---------------------------------------------------------------------------
// Wall segments (meters) from the layout — this is also the ground truth
// ---------------------------------------------------------------------------

function wallSegments(L) {
  const walls = []
  walls.push({ x1: 0, y1: 0, x2: L.W, y2: 0, t: L.extThick, ext: true })
  walls.push({ x1: L.W, y1: 0, x2: L.W, y2: L.H, t: L.extThick, ext: true })
  walls.push({ x1: L.W, y1: L.H, x2: 0, y2: L.H, t: L.extThick, ext: true })
  walls.push({ x1: 0, y1: L.H, x2: 0, y2: 0, t: L.extThick, ext: true })
  for (const p of L.partitions) {
    // subtract open-plan gaps: the partition simply doesn't exist there
    let spans = [{ lo: p.a0, hi: p.a1 }]
    for (const g of L.openGaps || []) {
      if (g.axis !== p.axis || Math.abs(g.c - p.c) > 1e-6) continue
      const next = []
      for (const s of spans) {
        if (g.hi <= s.lo || g.lo >= s.hi) { next.push(s); continue }
        if (g.lo > s.lo) next.push({ lo: s.lo, hi: g.lo })
        if (g.hi < s.hi) next.push({ lo: g.hi, hi: s.hi })
      }
      spans = next
    }
    for (const s of spans) {
      if (s.hi - s.lo < 0.15) continue
      if (p.axis === 'v') walls.push({ x1: p.c, y1: s.lo, x2: p.c, y2: s.hi, t: L.intThick, ext: false })
      else walls.push({ x1: s.lo, y1: p.c, x2: s.hi, y2: p.c, t: L.intThick, ext: false })
    }
  }
  return walls
}

// ---------------------------------------------------------------------------
// Style sampling
// ---------------------------------------------------------------------------

// Charter is deliberately absent: this system only has it as legacy Type1
// (.pfb), which resvg's font engine (TTF/OTF/TTC only) can't parse — with
// loadSystemFonts:true it silently fell back to a default, wasting the
// "diversity" slot; with explicit fontFiles it just wouldn't render.
const FONTS = ['DejaVu Sans', 'FreeSans', 'DejaVu Serif', 'DejaVu Sans Mono']

function sampleStyle() {
  return {
    ppm: rand(28, 60),
    wallStyle: pick(['solid', 'solid', 'solid', 'double', 'gray', 'hatch', 'cadgray', 'cadgray']),
    ink: pick(['#000000', '#000000', '#1a1a1a', '#22262e', '#26303b']),
    background: pick(['#ffffff', '#ffffff', '#fdfcf8', 'grid', 'dots']),
    font: pick(FONTS),
    fontSize: rand(10, 15),
    labelArea: chance(0.75),
    dims: chance(0.7),
    dimUnit: pick(['m', 'm', 'mm']),
    roomDims: chance(0.3),
    furniture: chance(0.75),
    doorArcs: chance(0.9),
    windowLines: randi(2, 3),
    northArrow: chance(0.4),
    titleBlock: chance(0.4),
    tintRooms: chance(0.2),
    thinStroke: rand(0.8, 2.6), // real plan furniture is often drawn bold
    furnFill: chance(0.35) ? pick(['#ececec', '#f1efe9', '#e9edf1']) : 'none',
    caption: chance(0.4),
    // CAD-drawing context — all pure distractors the model must NOT read as
    // structure (motivated by a real architect's site+floor drawing):
    dimChains: chance(0.5), // dimension chains INSIDE rooms, mm labels, ticks
    dimColor: pick(['#e08b2d', '#e08b2d', '#cc5533', '#666666']),
    plotBoundary: chance(0.35), // red dashed parcel boundary + survey markers + setbacks
    pool: chance(0.25), // dashed pool/deck rectangle outside the building
    stairs: chance(0.35), // stair treads + UP arrow in a small room
  }
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const f1 = (v) => (Math.round(v * 10) / 10).toString()

function renderSample(L, S) {
  let margin = S.dims ? rand(55, 95) : rand(20, 45)
  // a balcony hangs outside the footprint — widen all margins to fit it
  if (L.balcony) margin = Math.max(margin, L.balcony.depth * S.ppm + 18)
  // plot boundary / pool live outside the building — reserve yard space
  const plotPad = S.plotBoundary || S.pool ? rand(1.6, 3.6) : 0
  if (plotPad) margin = Math.max(margin, plotPad * S.ppm + 34)
  const px = (m) => margin + m * S.ppm
  const IW = Math.round(L.W * S.ppm + margin * 2)
  const IH = Math.round(L.H * S.ppm + margin * 2 + (S.titleBlock ? 34 : 0))
  const walls = wallSegments(L)

  const img = []
  const msk = []

  // --- backgrounds -----------------------------------------------------
  img.push(`<rect width="${IW}" height="${IH}" fill="${S.background.startsWith('#') ? S.background : '#ffffff'}"/>`)
  if (S.background === 'grid') {
    const g = rand(8, 15)
    img.push(`<path d="${gridPath(IW, IH, g)}" stroke="${pick(['#dce8f2', '#e3e6ea', '#dfe9df'])}" stroke-width="0.7" fill="none"/>`)
  } else if (S.background === 'dots') {
    const g = rand(10, 16)
    let d = ''
    for (let y = g; y < IH; y += g) for (let x = g; x < IW; x += g) d += `M${f1(x)} ${f1(y)}h0.01`
    img.push(`<path d="${d}" stroke="#c9d2da" stroke-width="1.4" stroke-linecap="round" fill="none"/>`)
  }
  msk.push(`<rect width="${IW}" height="${IH}" fill="#000000"/>`)

  // --- site context (image only, never mask): plot boundary, pool ---------
  if (S.plotBoundary) {
    const j = () => rand(-0.25, 0.25) // survey lines are never perfectly square
    const p0 = { x: px(-plotPad + j()), y: px(-plotPad + j()) }
    const p1 = { x: px(L.W + plotPad + j()), y: px(-plotPad + j()) }
    const p2 = { x: px(L.W + plotPad + j()), y: px(L.H + plotPad + j()) }
    const p3 = { x: px(-plotPad + j()), y: px(L.H + plotPad + j()) }
    const red = '#cc2222'
    img.push(`<polygon points="${[p0, p1, p2, p3].map((p) => f1(p.x) + ',' + f1(p.y)).join(' ')}" fill="none" stroke="${red}" stroke-width="2" stroke-dasharray="9 6"/>`)
    for (const p of [p0, p1, p2, p3]) {
      img.push(`<circle cx="${f1(p.x)}" cy="${f1(p.y)}" r="7" fill="#ffffff" stroke="${S.ink}" stroke-width="1.4"/>` +
        `<path d="M${f1(p.x)} ${f1(p.y)} L${f1(p.x + 7)} ${f1(p.y)} A7 7 0 0 1 ${f1(p.x)} ${f1(p.y + 7)} Z" fill="${S.ink}"/>`)
    }
    const plotW = (p1.x - p0.x) / S.ppm
    const plotH = (p3.y - p0.y) / S.ppm
    img.push(`<text x="${f1((p0.x + p1.x) / 2)}" y="${f1(p0.y - 10)}" font-family="${S.font}" font-size="14" font-weight="bold" fill="${S.ink}" text-anchor="middle">${plotW.toFixed(2)}m</text>`)
    img.push(`<text x="${f1(p0.x - 12)}" y="${f1((p0.y + p3.y) / 2)}" font-family="${S.font}" font-size="14" font-weight="bold" fill="${S.ink}" text-anchor="middle" transform="rotate(-90 ${f1(p0.x - 12)} ${f1((p0.y + p3.y) / 2)})">${plotH.toFixed(2)}m</text>`)
    // setback line + note
    const sb = rand(0.6, 1.2)
    img.push(`<rect x="${f1(p0.x + sb * S.ppm)}" y="${f1(p0.y + sb * S.ppm)}" width="${f1(p1.x - p0.x - 2 * sb * S.ppm)}" height="${f1(p3.y - p0.y - 2 * sb * S.ppm)}" fill="none" stroke="#3a9a3a" stroke-width="1" stroke-dasharray="5 4"/>`)
    img.push(`<text x="${f1(p0.x + sb * S.ppm + 6)}" y="${f1(p0.y + sb * S.ppm - 4)}" font-family="${S.font}" font-size="8" fill="#3a9a3a">${sb.toFixed(1)}m setback</text>`)
    img.push(`<text x="${f1(p2.x - 8)}" y="${f1(p2.y - 12)}" font-family="${S.font}" font-size="12" fill="${S.ink}" text-anchor="end">AREA : ${Math.round(plotW * plotH)}sqm</text>`)
  }
  if (S.pool) {
    // dashed pool rectangle in the yard (above or right of the building)
    const above = chance(0.6)
    const pw = rand(3, 6) * S.ppm
    const ph = rand(1.6, 3) * S.ppm
    const x0 = above ? px(rand(1, Math.max(1.2, L.W - 6))) : px(L.W + 0.4)
    const y0 = above ? px(-plotPad) + rand(8, 24) : px(rand(1, Math.max(1.2, L.H - 4)))
    img.push(`<rect x="${f1(x0)}" y="${f1(y0)}" width="${f1(pw)}" height="${f1(ph)}" fill="none" stroke="${S.ink}" stroke-width="1.4" stroke-dasharray="7 5"/>` +
      `<rect x="${f1(x0 + 6)}" y="${f1(y0 + 6)}" width="${f1(pw - 12)}" height="${f1(ph - 12)}" fill="none" stroke="${S.ink}" stroke-width="0.8" stroke-dasharray="4 4"/>`)
  }

  // room tints + furniture live under the walls
  if (S.tintRooms) {
    for (const r of L.rooms) {
      img.push(`<rect x="${f1(px(r.x))}" y="${f1(px(r.y))}" width="${f1(r.w * S.ppm)}" height="${f1(r.h * S.ppm)}" fill="${pick(['#f7f4ee', '#f2f5f7', '#f6f2f2', '#f0f4ef'])}"/>`)
    }
  }
  if (S.furniture) for (const r of L.rooms) img.push(furnitureSVG(r, px, S))
  if (S.stairs) {
    // stair treads + UP arrow in the smallest suitable room — the classic
    // parallel-line hatch that models love to misread as walls
    const cand = [...L.rooms].filter((r) => r.w > 1.6 && r.h > 1.6).sort((a, b) => a.area - b.area)[0]
    if (cand) {
      const vertical = cand.h >= cand.w
      const n = Math.floor((vertical ? cand.h : cand.w) * 0.55 / 0.27)
      const parts = []
      for (let i = 0; i < n; i++) {
        const t = 0.3 + i * 0.27
        if (vertical) {
          parts.push(`<line x1="${f1(px(cand.x + 0.25))}" y1="${f1(px(cand.y + t))}" x2="${f1(px(cand.x + cand.w - 0.25))}" y2="${f1(px(cand.y + t))}" stroke="${S.ink}" stroke-width="${f1(S.thinStroke)}"/>`)
        } else {
          parts.push(`<line x1="${f1(px(cand.x + t))}" y1="${f1(px(cand.y + 0.25))}" x2="${f1(px(cand.x + t))}" y2="${f1(px(cand.y + cand.h - 0.25))}" stroke="${S.ink}" stroke-width="${f1(S.thinStroke)}"/>`)
        }
      }
      // direction arrow + UP label
      const ax = px(cand.x + cand.w / 2)
      const ay0 = px(cand.y + cand.h - 0.35)
      const ay1 = px(cand.y + 0.4)
      if (vertical) {
        parts.push(`<line x1="${f1(ax)}" y1="${f1(ay0)}" x2="${f1(ax)}" y2="${f1(ay1)}" stroke="${S.ink}" stroke-width="1.1"/>`)
        parts.push(`<path d="M${f1(ax)} ${f1(ay1)} l-4 8 l8 0 Z" fill="${S.ink}"/>`)
      }
      parts.push(`<text x="${f1(ax + 6)}" y="${f1(px(cand.y + cand.h / 2))}" font-family="${S.font}" font-size="9" font-weight="bold" fill="${pick(['#e08b2d', S.ink])}">UP</text>`)
      img.push(parts.join(''))
    }
  }

  // --- walls -------------------------------------------------------------
  if (S.wallStyle === 'hatch') {
    img.push(`<defs><pattern id="hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="6" stroke="${S.ink}" stroke-width="1.4"/></pattern></defs>`)
  }
  for (const w of walls) {
    const r = wallRect(w, px, S.ppm)
    const rect = `x="${f1(r.x)}" y="${f1(r.y)}" width="${f1(r.w)}" height="${f1(r.h)}"`
    if (S.wallStyle === 'solid') img.push(`<rect ${rect} fill="${S.ink}"/>`)
    else if (S.wallStyle === 'gray') img.push(`<rect ${rect} fill="#8b8f94" stroke="${S.ink}" stroke-width="1"/>`)
    else if (S.wallStyle === 'cadgray') img.push(`<rect ${rect} fill="#565b60" stroke="#2c3035" stroke-width="0.8"/>`)
    else if (S.wallStyle === 'hatch') img.push(`<rect ${rect} fill="url(#hatch)" stroke="${S.ink}" stroke-width="1.2"/>`)
    else img.push(`<rect ${rect} fill="#ffffff" stroke="${S.ink}" stroke-width="${f1(S.thinStroke * 1.2)}"/>`)
    msk.push(`<rect ${rect} fill="#ff0000"/>`)
  }

  // --- openings ------------------------------------------------------------
  for (const d of L.doors) {
    const t = d.c === 0 || Math.abs(d.c - L.W) < 1e-6 || Math.abs(d.c - L.H) < 1e-6 ? L.extThick : L.intThick
    const g = gapRect(d, t, px, S.ppm)
    img.push(`<rect x="${f1(g.x)}" y="${f1(g.y)}" width="${f1(g.w)}" height="${f1(g.h)}" fill="${S.background.startsWith('#') ? S.background : '#ffffff'}"/>`)
    msk.push(`<rect x="${f1(g.x)}" y="${f1(g.y)}" width="${f1(g.w)}" height="${f1(g.h)}" fill="#00ff00"/>`)
    if (d.kind === 'sliding') {
      // slider symbol: two offset panels along the wall line
      const wpx = d.width * S.ppm
      if (d.axis === 'v') {
        img.push(`<line x1="${f1(g.x + g.w * 0.3)}" y1="${f1(g.y)}" x2="${f1(g.x + g.w * 0.3)}" y2="${f1(g.y + wpx * 0.55)}" stroke="${S.ink}" stroke-width="2"/>` +
          `<line x1="${f1(g.x + g.w * 0.7)}" y1="${f1(g.y + wpx * 0.45)}" x2="${f1(g.x + g.w * 0.7)}" y2="${f1(g.y + g.h)}" stroke="${S.ink}" stroke-width="2"/>`)
      } else {
        img.push(`<line x1="${f1(g.x)}" y1="${f1(g.y + g.h * 0.3)}" x2="${f1(g.x + wpx * 0.55)}" y2="${f1(g.y + g.h * 0.3)}" stroke="${S.ink}" stroke-width="2"/>` +
          `<line x1="${f1(g.x + wpx * 0.45)}" y1="${f1(g.y + g.h * 0.7)}" x2="${f1(g.x + g.w)}" y2="${f1(g.y + g.h * 0.7)}" stroke="${S.ink}" stroke-width="2"/>`)
      }
    } else if (d.kind !== 'doorway' && S.doorArcs) {
      img.push(doorArcSVG(d, px, S.ppm))
    }
  }
  for (const w of L.windows) {
    const g = gapRect(w, L.extThick, px, S.ppm)
    img.push(`<rect x="${f1(g.x)}" y="${f1(g.y)}" width="${f1(g.w)}" height="${f1(g.h)}" fill="#ffffff" stroke="${S.ink}" stroke-width="${f1(S.thinStroke)}"/>`)
    // parallel glazing lines along the wall direction
    for (let i = 1; i < S.windowLines; i++) {
      const f = i / S.windowLines
      if (w.axis === 'v') {
        const x = g.x + g.w * f
        img.push(`<line x1="${f1(x)}" y1="${f1(g.y)}" x2="${f1(x)}" y2="${f1(g.y + g.h)}" stroke="${S.ink}" stroke-width="${f1(S.thinStroke)}"/>`)
      } else {
        const y = g.y + g.h * f
        img.push(`<line x1="${f1(g.x)}" y1="${f1(y)}" x2="${f1(g.x + g.w)}" y2="${f1(y)}" stroke="${S.ink}" stroke-width="${f1(S.thinStroke)}"/>`)
      }
    }
    msk.push(`<rect x="${f1(g.x)}" y="${f1(g.y)}" width="${f1(g.w)}" height="${f1(g.h)}" fill="#0000ff"/>`)
  }

  // --- labels ----------------------------------------------------------
  for (const r of L.rooms) {
    const cx = px(r.x + r.w / 2)
    const cy = px(r.y + r.h / 2)
    const fs = Math.min(S.fontSize, (r.w * S.ppm) / (r.name.length * 0.62))
    if (fs < 6.5) continue
    const label = chance(0.15) ? r.name.toUpperCase() : r.name
    img.push(`<text x="${f1(cx)}" y="${f1(cy)}" font-family="${S.font}" font-size="${f1(fs)}" fill="${S.ink}" text-anchor="middle">${esc(label)}</text>`)
    if (S.labelArea && fs > 7.5) {
      img.push(`<text x="${f1(cx)}" y="${f1(cy + fs * 1.25)}" font-family="${S.font}" font-size="${f1(fs * 0.82)}" fill="${S.ink}" text-anchor="middle">${r.area.toFixed(1)} m²</text>`)
    }
    if (S.roomDims && fs > 7.5) {
      img.push(`<text x="${f1(cx)}" y="${f1(cy + fs * 2.4)}" font-family="${S.font}" font-size="${f1(fs * 0.78)}" fill="${S.ink}" text-anchor="middle">${dimText(r.w, S)} x ${dimText(r.h, S)}</text>`)
    }
  }

  // --- dimension lines ---------------------------------------------------
  if (S.dims) {
    img.push(dimLineSVG(px(0), px(0) - rand(24, 38), px(L.W), 'h', dimText(L.W, S), S))
    img.push(dimLineSVG(px(0), px(0) - rand(24, 38), px(L.H), 'v', dimText(L.H, S), S))
    if (chance(0.5)) {
      // per-room chain along the top from the first horizontal partition set
      const xs = [...new Set(L.partitions.filter((p) => p.axis === 'v').map((p) => p.c))].sort((a, b) => a - b)
      let prev = 0
      const y = px(0) - rand(10, 16)
      for (const c of [...xs, L.W]) {
        if (c - prev > 1.2) img.push(dimLineSVG(px(prev), y, px(c), 'h', dimText(c - prev, S), S, true))
        prev = c
      }
    }
  }

  // --- balcony (image only — its railing is intentionally NOT in the mask) --
  if (L.balcony) {
    const b = L.balcony
    let bx, by, bw, bh
    if (b.axis === 'v') {
      bx = b.out < 0 ? px(b.c - b.depth) : px(b.c)
      by = px(b.lo); bw = b.depth * S.ppm; bh = (b.hi - b.lo) * S.ppm
    } else {
      bx = px(b.lo); by = b.out < 0 ? px(b.c - b.depth) : px(b.c)
      bw = (b.hi - b.lo) * S.ppm; bh = b.depth * S.ppm
    }
    const rail = rand(1.2, 2.2)
    img.push(`<rect x="${f1(bx)}" y="${f1(by)}" width="${f1(bw)}" height="${f1(bh)}" fill="none" stroke="${S.ink}" stroke-width="${f1(rail)}"/>`)
    // outdoor set: round table + two chairs
    const cx = bx + bw / 2, cy = by + bh / 2
    const tr = Math.min(bw, bh) * 0.16
    img.push(`<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(tr)}" fill="${S.furnFill}" stroke="${S.ink}" stroke-width="${f1(S.thinStroke)}"/>` +
      `<rect x="${f1(cx - tr * 2)}" y="${f1(cy - tr * 0.6)}" width="${f1(tr * 0.9)}" height="${f1(tr * 1.2)}" fill="${S.furnFill}" stroke="${S.ink}" stroke-width="${f1(S.thinStroke)}"/>` +
      `<rect x="${f1(cx + tr * 1.1)}" y="${f1(cy - tr * 0.6)}" width="${f1(tr * 0.9)}" height="${f1(tr * 1.2)}" fill="${S.furnFill}" stroke="${S.ink}" stroke-width="${f1(S.thinStroke)}"/>`)
    const bfs = Math.min(S.fontSize, bw / 6)
    if (bfs > 6.5) {
      img.push(`<text x="${f1(cx)}" y="${f1(by + bh * 0.22)}" font-family="${S.font}" font-size="${f1(bfs)}" fill="${S.ink}" text-anchor="middle">Balcony</text>`)
    }
  }

  // --- caption ("TOTAL AREA = 71 m²" style) ------------------------------
  if (S.caption) {
    const total = L.rooms.reduce((s, r) => s + r.area, 0)
    img.push(`<text x="${f1(IW / 2)}" y="${f1(IH - 10)}" font-family="${S.font}" font-size="${f1(rand(11, 15))}" fill="${S.ink}" text-anchor="middle" font-weight="bold">TOTAL AREA = ${Math.round(total)} m²</text>`)
  }

  // --- interior dimension chains (image only) — the defining feature of CAD
  // exports: thin colored lines with end ticks and mm labels running straight
  // through rooms, over walls, everywhere. Pure distractor.
  if (S.dimChains) {
    const parts = []
    const tick = (x, y, vert) => vert
      ? `<line x1="${f1(x - 3)}" y1="${f1(y + 3)}" x2="${f1(x + 3)}" y2="${f1(y - 3)}" stroke="${S.dimColor}" stroke-width="1"/>`
      : `<line x1="${f1(x - 3)}" y1="${f1(y + 3)}" x2="${f1(x + 3)}" y2="${f1(y - 3)}" stroke="${S.dimColor}" stroke-width="1"/>`
    for (const r of L.rooms) {
      if (!chance(0.55)) continue
      if (chance(0.5) && r.w > 1.6) {
        // horizontal chain across the room
        const y = px(r.y + r.h * rand(0.2, 0.8))
        const x0 = px(r.x + 0.15)
        const x1 = px(r.x + r.w - 0.15)
        parts.push(`<line x1="${f1(x0)}" y1="${f1(y)}" x2="${f1(x1)}" y2="${f1(y)}" stroke="${S.dimColor}" stroke-width="0.9"/>`)
        parts.push(tick(x0, y), tick(x1, y))
        parts.push(`<text x="${f1((x0 + x1) / 2)}" y="${f1(y - 3)}" font-family="${S.font}" font-size="8" fill="${S.dimColor}" text-anchor="middle">${Math.round((r.w - 0.3) * 1000)}</text>`)
      }
      if (chance(0.5) && r.h > 1.6) {
        const x = px(r.x + r.w * rand(0.2, 0.8))
        const y0 = px(r.y + 0.15)
        const y1 = px(r.y + r.h - 0.15)
        parts.push(`<line x1="${f1(x)}" y1="${f1(y0)}" x2="${f1(x)}" y2="${f1(y1)}" stroke="${S.dimColor}" stroke-width="0.9"/>`)
        parts.push(tick(x, y0, true), tick(x, y1, true))
        parts.push(`<text x="${f1(x - 3)}" y="${f1((y0 + y1) / 2)}" font-family="${S.font}" font-size="8" fill="${S.dimColor}" text-anchor="middle" transform="rotate(-90 ${f1(x - 3)} ${f1((y0 + y1) / 2)})">${Math.round((r.h - 0.3) * 1000)}</text>`)
      }
    }
    // a couple of long chains spanning the whole building, CAD-style
    for (let i = 0; i < randi(1, 2); i++) {
      const y = px(rand(0.5, L.H - 0.5))
      parts.push(`<line x1="${f1(px(0))}" y1="${f1(y)}" x2="${f1(px(L.W))}" y2="${f1(y)}" stroke="${S.dimColor}" stroke-width="0.8" opacity="0.85"/>`)
      parts.push(tick(px(0), y), tick(px(L.W), y))
    }
    img.push(parts.join(''))
  }

  if (S.northArrow) {
    const nx = IW - rand(28, 46), ny = rand(30, 52)
    img.push(`<circle cx="${f1(nx)}" cy="${f1(ny)}" r="13" fill="none" stroke="${S.ink}" stroke-width="1.2"/>` +
      `<path d="M${f1(nx)} ${f1(ny - 10)} L${f1(nx - 4.5)} ${f1(ny + 7)} L${f1(nx)} ${f1(ny + 3)} L${f1(nx + 4.5)} ${f1(ny + 7)} Z" fill="${S.ink}"/>` +
      `<text x="${f1(nx)}" y="${f1(ny - 16)}" font-family="${S.font}" font-size="10" fill="${S.ink}" text-anchor="middle">N</text>`)
  }
  if (S.titleBlock) {
    img.push(`<text x="${f1(IW - 12)}" y="${f1(IH - 12)}" font-family="${S.font}" font-size="11" fill="${S.ink}" text-anchor="end">${pick(['FLOOR PLAN', 'GROUND FLOOR', 'FIRST FLOOR PLAN', 'PLAN VIEW'])}  ·  SCALE 1:${pick([50, 100, 100, 200])}</text>`)
  }

  // --- ground truth (pixels, Stride analyzer schema) ---------------------
  const gt = {
    planType: 'floor_residential',
    planName: 'Synthetic plan',
    confidence: 1,
    imageSize: { width: IW, height: IH },
    scale: { pixelsPerMeter: S.ppm, confidence: 1, source: 'dimension_label' },
    walls: walls.map((w) => ({
      start: { x: px(w.x1), y: px(w.y1) },
      end: { x: px(w.x2), y: px(w.y2) },
      thickness: w.t * S.ppm,
      isExterior: w.ext,
    })),
    doors: L.doors.map((d) => ({
      center: d.axis === 'v' ? { x: px(d.c), y: px(d.pos) } : { x: px(d.pos), y: px(d.c) },
      width: d.width * S.ppm,
      kind: d.kind,
    })),
    windows: L.windows.map((w) => ({
      center: w.axis === 'v' ? { x: px(w.c), y: px(w.pos) } : { x: px(w.pos), y: px(w.c) },
      width: w.width * S.ppm,
    })),
    rooms: L.rooms.map((r) => ({
      name: r.name,
      type: r.type,
      center: { x: px(r.x + r.w / 2), y: px(r.y + r.h / 2) },
      labeledArea: Math.round(r.area * 10) / 10,
    })),
  }

  const svgOpen = `<svg xmlns="http://www.w3.org/2000/svg" width="${IW}" height="${IH}">`
  return {
    imageSvg: `${svgOpen}${img.join('')}</svg>`,
    maskSvg: `${svgOpen}<g shape-rendering="crispEdges">${msk.join('')}</g></svg>`,
    gt,
  }
}

// wall segment (meters) -> pixel rect, extended by half thickness at both ends
// so corners close
function wallRect(w, px, ppm) {
  const t = w.t * ppm
  const x1 = px(Math.min(w.x1, w.x2)), x2 = px(Math.max(w.x1, w.x2))
  const y1 = px(Math.min(w.y1, w.y2)), y2 = px(Math.max(w.y1, w.y2))
  return x1 === x2
    ? { x: x1 - t / 2, y: y1 - t / 2, w: t, h: y2 - y1 + t }
    : { x: x1 - t / 2, y: y1 - t / 2, w: x2 - x1 + t, h: t }
}

// opening (door/window) -> pixel rect covering the wall breadth
function gapRect(o, t, px, ppm) {
  const half = (o.width / 2) * ppm
  const tp = t * ppm
  return o.axis === 'v'
    ? { x: px(o.c) - tp / 2, y: px(o.pos) - half, w: tp, h: half * 2 }
    : { x: px(o.pos) - half, y: px(o.c) - tp / 2, w: half * 2, h: tp }
}

function doorArcSVG(d, px, ppm) {
  const w = d.width * ppm
  const flip = chance(0.5) ? 1 : -1
  const swing = chance(0.5) ? 1 : -1
  let hx, hy, lx, ly // hinge and open-leaf tip (perpendicular to the wall)
  if (d.axis === 'v') {
    hx = px(d.c); hy = px(d.pos) - (w / 2) * flip
    lx = hx + w * swing; ly = hy
  } else {
    hx = px(d.pos) - (w / 2) * flip; hy = px(d.c)
    lx = hx; ly = hy + w * swing
  }
  // arc sweeps from the open leaf tip back to the far side of the gap
  const arcEnd = d.axis === 'v' ? { x: hx, y: hy + w * flip } : { x: hx + w * flip, y: hy }
  const sweep = (flip * swing) > 0 ? 1 : 0
  return `<line x1="${f1(hx)}" y1="${f1(hy)}" x2="${f1(lx)}" y2="${f1(ly)}" stroke="#333" stroke-width="1.6"/>` +
    `<path d="M${f1(lx)} ${f1(ly)} A${f1(w)} ${f1(w)} 0 0 ${sweep} ${f1(arcEnd.x)} ${f1(arcEnd.y)}" fill="none" stroke="#555" stroke-width="0.9"/>`
}

function dimText(meters, S) {
  return S.dimUnit === 'mm' ? String(Math.round(meters * 1000)) : meters.toFixed(2)
}

// dimension line with end ticks + centered label; axis 'h' (along top) or 'v'
// (down the left edge, rendered by swapping coordinates)
function dimLineSVG(a, off, b, axis, label, S, minor = false) {
  const fs = minor ? 8.5 : 10
  const tick = 4
  const mid = (a + b) / 2
  if (axis === 'h') {
    return `<line x1="${f1(a)}" y1="${f1(off)}" x2="${f1(b)}" y2="${f1(off)}" stroke="${S.ink}" stroke-width="0.9"/>` +
      `<line x1="${f1(a)}" y1="${f1(off - tick)}" x2="${f1(a)}" y2="${f1(off + tick)}" stroke="${S.ink}" stroke-width="0.9"/>` +
      `<line x1="${f1(b)}" y1="${f1(off - tick)}" x2="${f1(b)}" y2="${f1(off + tick)}" stroke="${S.ink}" stroke-width="0.9"/>` +
      `<text x="${f1(mid)}" y="${f1(off - 4)}" font-family="${S.font}" font-size="${fs}" fill="${S.ink}" text-anchor="middle">${label}</text>`
  }
  // vertical: line runs down the left, at x=off; a/b are y pixel coords
  return `<line x1="${f1(off)}" y1="${f1(a)}" x2="${f1(off)}" y2="${f1(b)}" stroke="${S.ink}" stroke-width="0.9"/>` +
    `<line x1="${f1(off - tick)}" y1="${f1(a)}" x2="${f1(off + tick)}" y2="${f1(a)}" stroke="${S.ink}" stroke-width="0.9"/>` +
    `<line x1="${f1(off - tick)}" y1="${f1(b)}" x2="${f1(off + tick)}" y2="${f1(b)}" stroke="${S.ink}" stroke-width="0.9"/>` +
    `<text x="${f1(off - 4)}" y="${f1(mid)}" font-family="${S.font}" font-size="${fs}" fill="${S.ink}" text-anchor="middle" transform="rotate(-90 ${f1(off - 4)} ${f1(mid)})">${label}</text>`
}

function gridPath(w, h, g) {
  let d = ''
  for (let x = g; x < w; x += g) d += `M${f1(x)} 0V${h}`
  for (let y = g; y < h; y += g) d += `M0 ${f1(y)}H${w}`
  return d
}

// ---------------------------------------------------------------------------
// Furniture distractors — thin-stroke symbols the model must learn to ignore
// ---------------------------------------------------------------------------

function furnitureSVG(room, px, S) {
  const s = []
  const stroke = `fill="${S.furnFill}" stroke="${pick(['#444', '#555', S.ink])}" stroke-width="${f1(S.thinStroke)}"`
  const rx = px(room.x), ry = px(room.y)
  const rw = room.w * S.ppm, rh = room.h * S.ppm
  const m = 0.35 * S.ppm // clearance from walls
  const box = (x, y, w, h) => `<rect x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="${f1(h)}" ${stroke}/>`

  if (room.type === 'bedroom' && room.w > 2.8 && room.h > 2.8) {
    const bw = 1.5 * S.ppm, bh = 2.0 * S.ppm
    s.push(box(rx + m, ry + m, bw, bh))
    s.push(box(rx + m + bw * 0.08, ry + m + 3, bw * 0.36, bh * 0.22))
    s.push(box(rx + m + bw * 0.56, ry + m + 3, bw * 0.36, bh * 0.22))
    if (room.w > 3.6) s.push(box(rx + rw - m - 0.6 * S.ppm, ry + m, 0.6 * S.ppm, Math.min(1.8, room.h - 1) * S.ppm))
  } else if (room.type === 'living' && room.w > 3 && room.h > 3) {
    const sw = Math.min(2.2, room.w - 1.4) * S.ppm
    s.push(box(rx + m, ry + rh - m - 0.85 * S.ppm, sw, 0.85 * S.ppm))
    s.push(box(rx + m + sw * 0.2, ry + rh - m - 2.0 * S.ppm, sw * 0.6, 0.6 * S.ppm))
    if (chance(0.7)) s.push(box(rx + rw - m - 0.4 * S.ppm, ry + m, 0.4 * S.ppm, Math.min(1.6, room.h * 0.4) * S.ppm))
  } else if (room.type === 'kitchen') {
    // counter run with hob burners, sink and a fridge — drawn boldly, the way
    // RoomSketcher-style plans do, so the model learns counters aren't walls
    const d = 0.6 * S.ppm
    const runW = Math.min(rw - m * 1.2, rw * 0.9)
    s.push(box(rx + m * 0.6, ry + m * 0.6, runW, d))
    const hobX = rx + m * 0.6 + runW * 0.32
    s.push(box(hobX, ry + m * 0.6 + 1, d * 1.1, d - 2))
    for (let i = 0; i < 4; i++) {
      s.push(`<circle cx="${f1(hobX + d * (0.3 + 0.55 * (i % 2)))}" cy="${f1(ry + m * 0.6 + d * (0.28 + 0.45 * Math.floor(i / 2)))}" r="${f1(d * 0.14)}" ${stroke}/>`)
    }
    const sinkX = rx + m * 0.6 + runW * 0.7
    s.push(`<circle cx="${f1(sinkX)}" cy="${f1(ry + m * 0.6 + d * 0.5)}" r="${f1(d * 0.26)}" ${stroke}/>`)
    if (runW > 3 * d) {
      const frX = rx + m * 0.6 + runW - d * 1.05
      s.push(box(frX, ry + m * 0.6 + 1, d, d - 2))
      const ffs = d * 0.34
      if (ffs > 6) s.push(`<text x="${f1(frX + d / 2)}" y="${f1(ry + m * 0.6 + d * 0.6)}" font-family="${S.font}" font-size="${f1(ffs)}" fill="${S.ink}" text-anchor="middle">R/F</text>`)
    }
  } else if (room.type === 'bathroom') {
    const tw = 0.42 * S.ppm
    s.push(`<ellipse cx="${f1(rx + m + tw / 2)}" cy="${f1(ry + m + tw * 0.8)}" rx="${f1(tw / 2)}" ry="${f1(tw * 0.65)}" ${stroke}/>`)
    s.push(box(rx + m + tw * 0.1, ry + m - 2, tw * 0.8, tw * 0.4))
    if (room.w > 1.9 && room.h > 1.9) {
      const bw = Math.min(1.7, room.w - 1) * S.ppm
      s.push(box(rx + rw - m - bw, ry + rh - m - 0.75 * S.ppm, bw, 0.75 * S.ppm))
    }
    s.push(`<circle cx="${f1(rx + rw - m - 0.3 * S.ppm)}" cy="${f1(ry + m + 0.25 * S.ppm)}" r="${f1(0.2 * S.ppm)}" ${stroke}/>`)
  } else if ((room.type === 'living' || room.type === 'kitchen') || (room.type === 'bedroom' && chance(0.3))) {
    // small table + chairs fallback
  }
  if ((room.type === 'living' || room.type === 'kitchen') && room.w > 2.6 && room.h > 2.6 && chance(0.6)) {
    const cx = rx + rw / 2, cy = ry + rh / 2
    const tw = 0.9 * S.ppm
    s.push(box(cx - tw / 2, cy - tw / 2, tw, tw * 0.7))
    s.push(box(cx - tw * 0.25, cy - tw / 2 - 0.35 * S.ppm, tw * 0.5, 0.3 * S.ppm))
    s.push(box(cx - tw * 0.25, cy + tw * 0.2 + 0.05 * S.ppm, tw * 0.5, 0.3 * S.ppm))
  }
  return s.join('')
}

// ---------------------------------------------------------------------------
// Worker: render `count` samples starting at global index START. Used
// directly for small counts, or invoked as a subprocess per chunk otherwise.
// ---------------------------------------------------------------------------

function renderRange(start, count, out) {
  mkdirSync(out, { recursive: true })
  const t0 = Date.now()
  for (let k = 0; k < count; k++) {
    const i = start + k
    rng = mulberry32(SEED * 1_000_003 + i)
    const layout = generateLayout()
    const style = sampleStyle()
    const { imageSvg, maskSvg, gt } = renderSample(layout, style)
    const id = String(i).padStart(5, '0')
    writeFileSync(join(out, `img_${id}.png`), new Resvg(imageSvg, RESVG_OPTS).render().asPng())
    writeFileSync(join(out, `msk_${id}.png`), new Resvg(maskSvg, RESVG_OPTS).render().asPng())
    writeFileSync(join(out, `gt_${id}.json`), JSON.stringify(gt))
    if ((k + 1) % 50 === 0 || k === count - 1) {
      console.log(`${i + 1}/${START_TOTAL || count}  (${((Date.now() - t0) / (k + 1)).toFixed(0)} ms/sample, this process)`)
    }
  }
}

// ---------------------------------------------------------------------------
// Driver: for large counts, restart in fresh subprocesses every CHUNK
// samples so resvg's native leak (see CHUNK comment above) can't accumulate
// past a bounded ceiling — instead of growing until the OS kills the process
// partway through, silently truncating the dataset.
// ---------------------------------------------------------------------------

const START_TOTAL = args._worker ? parseInt(args.total || '0', 10) : 0

if (args._worker || COUNT <= CHUNK) {
  renderRange(START, COUNT, OUT)
  if (!args._worker) verifyComplete(0, COUNT, OUT)
} else {
  const t0 = Date.now()
  const self = fileURLToPath(import.meta.url)
  for (let start = 0; start < COUNT; start += CHUNK) {
    const n = Math.min(CHUNK, COUNT - start)
    const res = spawnSync(process.execPath, [
      self, '--count', String(n), '--out', OUT, '--seed', String(SEED),
      '--start', String(start), '--total', String(COUNT), '--_worker',
    ], { stdio: 'inherit' })
    if (res.status !== 0 || res.signal) {
      console.error(
        `\ngenerate.mjs: chunk [${start}, ${start + n}) failed ` +
        `(exit ${res.status}, signal ${res.signal || 'none'}) — ` +
        `${res.signal === 'SIGKILL' ? 'likely OOM-killed; try a smaller --chunk' : 'see output above'}.` +
        `\nStopping — dataset in ${OUT} is INCOMPLETE, do not train on it.`
      )
      process.exit(1)
    }
  }
  console.log(`all chunks done in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  verifyComplete(0, COUNT, OUT)
}

// Fail loudly and non-zero if any expected file is missing — a partial
// dataset must never be mistaken for a complete one by a calling script.
function verifyComplete(start, count, out) {
  // readdirSync, not fs.globSync — the latter is Node 22+ only and Colab
  // ships Node 20, where it's undefined and would throw here at the finish
  // line (exactly the failure this comment now prevents).
  const found = readdirSync(out).filter((f) => f.startsWith('img_') && f.endsWith('.png')).length
  if (found !== count) {
    console.error(`generate.mjs: expected ${count} images in ${out}, found ${found}. Dataset is INCOMPLETE.`)
    process.exit(1)
  }
  console.log(`done → ${out} (${count} samples verified)`)
}
