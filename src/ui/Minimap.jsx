// North-up minimap. The plan (walls, rooms, doors — or site boundary and
// road) is rendered once to an offscreen canvas; each pose update just
// composites that layer plus the player marker and view cone.
import { useEffect, useMemo, useRef } from 'react'
import { useStride } from '../store.js'

const SIZE = 172 // css pixels
const PAD = 14

function buildStaticLayer(plan, dpr) {
  const c = document.createElement('canvas')
  c.width = SIZE * dpr
  c.height = SIZE * dpr
  const ctx = c.getContext('2d')
  ctx.scale(dpr, dpr)

  const b = plan.bounds
  const spanX = b.maxX - b.minX
  const spanZ = b.maxZ - b.minZ
  const scale = Math.min((SIZE - PAD * 2) / spanX, (SIZE - PAD * 2) / spanZ)
  const ox = (SIZE - spanX * scale) / 2 - b.minX * scale
  const oz = (SIZE - spanZ * scale) / 2 - b.minZ * scale
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
  }

  // north arrow
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.font = '600 9px -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('N', SIZE - 12, 16)
  ctx.beginPath()
  ctx.moveTo(SIZE - 12, 19)
  ctx.lineTo(SIZE - 15, 26)
  ctx.lineTo(SIZE - 9, 26)
  ctx.closePath()
  ctx.fill()

  return { canvas: c, X, Z }
}

export default function Minimap() {
  const plan = useStride((s) => s.plan)
  const pose = useStride((s) => s.playerPose)
  const canvasRef = useRef()
  const dpr = Math.min(2, window.devicePixelRatio || 1)

  const layer = useMemo(() => (plan ? buildStaticLayer(plan, dpr) : null), [plan, dpr])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !layer) return
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, SIZE, SIZE)
    ctx.drawImage(layer.canvas, 0, 0, SIZE, SIZE)

    // player marker: view cone + dot. World forward = (-sin yaw, -cos yaw);
    // canvas x right, z down matches world x/z directly (north-up).
    const px = layer.X(pose.x)
    const pz = layer.Z(pose.z)
    const heading = Math.atan2(-Math.cos(pose.yaw), -Math.sin(pose.yaw))

    ctx.save()
    ctx.translate(px, pz)
    ctx.rotate(heading + Math.PI / 2) // canvas 0-angle points +x; cone drawn pointing up
    const cone = ctx.createLinearGradient(0, 0, 0, -26)
    cone.addColorStop(0, 'rgba(232, 183, 74, 0.55)')
    cone.addColorStop(1, 'rgba(232, 183, 74, 0)')
    ctx.fillStyle = cone
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.arc(0, 0, 26, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55)
    ctx.closePath()
    ctx.fill()
    ctx.restore()

    ctx.beginPath()
    ctx.arc(px, pz, 4, 0, Math.PI * 2)
    ctx.fillStyle = '#e8b74a'
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = 'rgba(20,20,24,0.9)'
    ctx.stroke()
  }, [layer, pose, dpr])

  if (!plan) return null
  return (
    <div className="minimap hud-card">
      <canvas
        ref={canvasRef}
        width={SIZE * dpr}
        height={SIZE * dpr}
        style={{ width: SIZE, height: SIZE }}
      />
    </div>
  )
}
