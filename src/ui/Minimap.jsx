// North-up minimap. The plan (walls, rooms, doors — or site boundary and
// road) is rendered once to an offscreen canvas; each pose update just
// composites that layer plus the player marker and view cone.
//
// Click the small map (or press M) to expand it into a full-screen overlay —
// large enough to read the whole plan, with room names and areas labeled.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStride } from '../store.js'

const SIZE = 172 // css pixels (docked map)
const PAD = 14

function buildStaticLayer(plan, dpr, size, { labels = false } = {}) {
  const pad = Math.max(PAD, size * 0.06)
  const c = document.createElement('canvas')
  c.width = size * dpr
  c.height = size * dpr
  const ctx = c.getContext('2d')
  ctx.scale(dpr, dpr)

  const b = plan.bounds
  const spanX = b.maxX - b.minX
  const spanZ = b.maxZ - b.minZ
  const scale = Math.min((size - pad * 2) / spanX, (size - pad * 2) / spanZ)
  const ox = (size - spanX * scale) / 2 - b.minX * scale
  const oz = (size - spanZ * scale) / 2 - b.minZ * scale
  const X = (x) => ox + x * scale
  const Z = (z) => oz + z * scale

  if (plan.planType === 'site') {
    const poly = plan.site.boundary
    // road band
    const re = plan.site.roadEdge
    if (re) {
      const c0 = plan.site.centroid
      const mid = { x: (re.start.x + re.end.x) / 2, z: (re.start.z + re.end.z) / 2 }
      const ux = re.end.x - re.start.x, uz = re.end.z - re.start.z
      const len = Math.hypot(ux, uz) || 1
      let nx = mid.x - c0.x, nz = mid.z - c0.z
      const d = (nx * ux + nz * uz) / (len * len)
      nx -= ux * d; nz -= uz * d
      const nl = Math.hypot(nx, nz) || 1
      nx /= nl; nz /= nl
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'
      ctx.lineWidth = 5.5 * scale
      ctx.beginPath()
      ctx.moveTo(X(re.start.x + nx * 4.5), Z(re.start.z + nz * 4.5))
      ctx.lineTo(X(re.end.x + nx * 4.5), Z(re.end.z + nz * 4.5))
      ctx.stroke()
    }
    ctx.beginPath()
    poly.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Z(p.z)) : ctx.moveTo(X(p.x), Z(p.z))))
    ctx.closePath()
    ctx.fillStyle = 'rgba(140, 180, 110, 0.25)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(240, 238, 228, 0.9)'
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 3])
    ctx.stroke()
    ctx.setLineDash([])
    // pegs
    ctx.fillStyle = '#e8b74a'
    for (const p of poly) {
      ctx.beginPath()
      ctx.arc(X(p.x), Z(p.z), 2, 0, Math.PI * 2)
      ctx.fill()
    }
    if (labels && plan.site.areaM2) {
      const c0 = plan.site.centroid
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.font = `600 ${Math.max(12, size * 0.024)}px -apple-system, sans-serif`
      ctx.textAlign = 'center'
      ctx.fillText(`${Math.round(plan.site.areaM2)} m²`, X(c0.x), Z(c0.z))
    }
  } else {
    // room fills
    ctx.fillStyle = 'rgba(255,255,255,0.10)'
    for (const room of plan.rooms) {
      for (const r of room.floorRects) {
        ctx.fillRect(X(r.x), Z(r.z), r.w * scale, r.d * scale)
      }
    }
    // walls with door gaps
    ctx.strokeStyle = 'rgba(240, 238, 228, 0.85)'
    ctx.lineCap = 'butt'
    for (const wall of plan.walls) {
      const len = Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z)
      if (len < 0.01) continue
      const ux = (wall.end.x - wall.start.x) / len
      const uz = (wall.end.z - wall.start.z) / len
      ctx.lineWidth = Math.max(1.2, wall.thickness * scale)
      const gaps = wall.openings
        .filter((o) => o.type !== 'window')
        .map((o) => [o.position - o.width / 2, o.position + o.width / 2])
        .sort((a, b) => a[0] - b[0])
      let cursor = 0
      const spans = []
      for (const [a, bb] of gaps) {
        if (a > cursor) spans.push([cursor, a])
        cursor = Math.max(cursor, bb)
      }
      if (cursor < len) spans.push([cursor, len])
      for (const [a, bb] of spans) {
        ctx.beginPath()
        ctx.moveTo(X(wall.start.x + ux * a), Z(wall.start.z + uz * a))
        ctx.lineTo(X(wall.start.x + ux * bb), Z(wall.start.z + uz * bb))
        ctx.stroke()
      }
    }
    // windows as light ticks across the wall line
    if (labels) {
      ctx.strokeStyle = 'rgba(150, 200, 255, 0.8)'
      for (const wall of plan.walls) {
        const len = Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z)
        if (len < 0.01) continue
        const ux = (wall.end.x - wall.start.x) / len
        const uz = (wall.end.z - wall.start.z) / len
        ctx.lineWidth = Math.max(1.5, wall.thickness * scale * 0.5)
        for (const o of wall.openings) {
          if (o.type !== 'window') continue
          ctx.beginPath()
          ctx.moveTo(X(wall.start.x + ux * (o.position - o.width / 2)), Z(wall.start.z + uz * (o.position - o.width / 2)))
          ctx.lineTo(X(wall.start.x + ux * (o.position + o.width / 2)), Z(wall.start.z + uz * (o.position + o.width / 2)))
          ctx.stroke()
        }
      }
    }
    // room names + areas — only when there's space to read them
    if (labels) {
      ctx.textAlign = 'center'
      for (const room of plan.rooms) {
        const w = (room.bbox.maxX - room.bbox.minX) * scale
        const d = (room.bbox.maxZ - room.bbox.minZ) * scale
        const fs = Math.min(Math.max(11, size * 0.02), w / Math.max(4, room.name.length * 0.62))
        if (fs < 9 || d < fs * 2.6) continue
        ctx.fillStyle = 'rgba(255,255,255,0.92)'
        ctx.font = `600 ${fs}px -apple-system, sans-serif`
        ctx.fillText(room.name, X(room.center.x), Z(room.center.z) - fs * 0.15)
        ctx.fillStyle = 'rgba(255,255,255,0.55)'
        ctx.font = `500 ${fs * 0.85}px -apple-system, sans-serif`
        ctx.fillText(`${room.area.toFixed(1)} m²`, X(room.center.x), Z(room.center.z) + fs * 0.95)
      }
    }
  }

  // north arrow
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.font = `600 ${Math.max(9, size * 0.018)}px -apple-system, sans-serif`
  ctx.textAlign = 'center'
  ctx.fillText('N', size - 12, 16)
  ctx.beginPath()
  ctx.moveTo(size - 12, 19)
  ctx.lineTo(size - 15, 26)
  ctx.lineTo(size - 9, 26)
  ctx.closePath()
  ctx.fill()

  return { canvas: c, X, Z, size }
}

// composite the static layer + player marker onto a visible canvas
function drawFrame(canvas, layer, pose, dpr) {
  const ctx = canvas.getContext('2d')
  const size = layer.size
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, size, size)
  ctx.drawImage(layer.canvas, 0, 0, size, size)

  // player marker: view cone + dot. World forward = (-sin yaw, -cos yaw);
  // canvas x right, z down matches world x/z directly (north-up).
  const px = layer.X(pose.x)
  const pz = layer.Z(pose.z)
  const heading = Math.atan2(-Math.cos(pose.yaw), -Math.sin(pose.yaw))
  const coneR = Math.max(26, size * 0.09)
  const dotR = Math.max(4, size * 0.011)

  ctx.save()
  ctx.translate(px, pz)
  ctx.rotate(heading + Math.PI / 2) // canvas 0-angle points +x; cone drawn pointing up
  const cone = ctx.createLinearGradient(0, 0, 0, -coneR)
  cone.addColorStop(0, 'rgba(232, 183, 74, 0.55)')
  cone.addColorStop(1, 'rgba(232, 183, 74, 0)')
  ctx.fillStyle = cone
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.arc(0, 0, coneR, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55)
  ctx.closePath()
  ctx.fill()
  ctx.restore()

  ctx.beginPath()
  ctx.arc(px, pz, dotR, 0, Math.PI * 2)
  ctx.fillStyle = '#e8b74a'
  ctx.fill()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = 'rgba(20,20,24,0.9)'
  ctx.stroke()
}

export default function Minimap() {
  const plan = useStride((s) => s.plan)
  const pose = useStride((s) => s.playerPose)
  const [expanded, setExpanded] = useState(false)
  const canvasRef = useRef()
  const bigRef = useRef()
  const dpr = Math.min(2, window.devicePixelRatio || 1)

  // the expanded map fills most of the shorter screen edge
  const bigSize = useMemo(
    () => Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.86),
    [expanded] // eslint-disable-line react-hooks/exhaustive-deps -- re-measure on open
  )

  const layer = useMemo(() => (plan ? buildStaticLayer(plan, dpr, SIZE) : null), [plan, dpr])
  const bigLayer = useMemo(
    () => (plan && expanded ? buildStaticLayer(plan, dpr, bigSize, { labels: true }) : null),
    [plan, dpr, expanded, bigSize]
  )

  const open = useCallback(() => {
    document.exitPointerLock?.() // walking uses pointer lock — release it for the overlay
    setExpanded(true)
  }, [])
  const close = useCallback(() => setExpanded(false), [])

  // M toggles, Esc closes (Esc also naturally exits pointer lock first)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'm' || e.key === 'M') setExpanded((v) => { if (!v) document.exitPointerLock?.(); return !v })
      else if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (canvasRef.current && layer) drawFrame(canvasRef.current, layer, pose, dpr)
  }, [layer, pose, dpr])
  useEffect(() => {
    if (bigRef.current && bigLayer) drawFrame(bigRef.current, bigLayer, pose, dpr)
  }, [bigLayer, pose, dpr])

  if (!plan) return null
  return (
    <>
      <div
        className="minimap hud-card"
        onClick={open}
        title="Expand map (M)"
        role="button"
        aria-label="Expand map"
      >
        <canvas
          ref={canvasRef}
          width={SIZE * dpr}
          height={SIZE * dpr}
          style={{ width: SIZE, height: SIZE }}
        />
        <div className="minimap-expand">⤢</div>
      </div>
      {expanded && (
        <div className="minimap-overlay" onClick={close}>
          <div className="minimap-overlay-card hud-card" onClick={(e) => e.stopPropagation()}>
            <canvas
              ref={bigRef}
              width={bigSize * dpr}
              height={bigSize * dpr}
              style={{ width: bigSize, height: bigSize }}
            />
            <button className="minimap-close" onClick={close} aria-label="Close map">×</button>
            <div className="minimap-overlay-hint">{plan.name} · M or Esc to close</div>
          </div>
        </div>
      )}
    </>
  )
}
