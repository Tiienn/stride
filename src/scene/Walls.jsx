// Builds all static wall geometry for a plan: plaster wall bodies segmented
// around openings, skirting boards, window frames with glass, and door frames.
// Everything is merged into a handful of draw calls.
import * as THREE from 'three'
import { useMemo } from 'react'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { surfaceMaterial, MAT, worldUVsBox } from '../lib/textures.js'

const glassMaterial = new THREE.MeshPhysicalMaterial({
  color: '#dfeaf2',
  roughness: 0.12,
  metalness: 0,
  transparent: true,
  opacity: 0.12,
  envMapIntensity: 0.8,
  side: THREE.DoubleSide,
  depthWrite: false,
})

function box(w, h, d, x, y, z, angle, worldUV = true) {
  const g = new THREE.BoxGeometry(w, h, d)
  if (worldUV) worldUVsBox(g, w, h, d)
  const m = new THREE.Matrix4()
    .makeRotationY(-angle)
    .setPosition(x, y, z)
  g.applyMatrix4(m)
  return g
}

export function buildWallGeometry(plan) {
  const plaster = []
  const trim = []
  const glass = []

  for (const wall of plan.walls) {
    const len = Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z)
    if (len < 0.02) continue
    const angle = Math.atan2(wall.end.z - wall.start.z, wall.end.x - wall.start.x)
    const ux = (wall.end.x - wall.start.x) / len
    const uz = (wall.end.z - wall.start.z) / len
    const at = (t, y) => [wall.start.x + ux * t, y, wall.start.z + uz * t]
    const T = wall.thickness
    // a balcony/terrace parapet is a low solid wall open to the sky
    const H = wall.railing ? 1.05 : wall.height

    const openings = [...wall.openings].sort((a, b) => a.position - b.position)
    let cursor = 0
    const fullSpans = []
    for (const o of openings) {
      const a = o.position - o.width / 2
      const b = o.position + o.width / 2
      if (a > cursor + 0.01) fullSpans.push([cursor, a])
      cursor = Math.max(cursor, b)
    }
    if (cursor < len - 0.01) fullSpans.push([cursor, len])

    // Full-height wall segments + skirting
    for (const [a, b] of fullSpans) {
      const w = b - a
      const mid = at((a + b) / 2, H / 2)
      plaster.push(box(w, H, T, ...mid, angle))
      const skMid = at((a + b) / 2, 0.055)
      trim.push(box(w, 0.11, T + 0.028, ...skMid, angle))
    }

    // Per-opening: lintels, sills, frames, glass
    for (const o of openings) {
      const w = o.width
      const cmid = o.position
      if (o.type === 'window') {
        const sill = o.sillHeight
        const top = Math.min(H, sill + o.height)
        // wall below + above
        plaster.push(box(w, sill, T, ...at(cmid, sill / 2), angle))
        if (top < H) plaster.push(box(w, H - top, T, ...at(cmid, (H + top) / 2), angle))
        // frame: head, sill board, jambs
        const fd = T + 0.02
        trim.push(box(w, 0.06, fd, ...at(cmid, top - 0.03), angle))
        trim.push(box(w + 0.08, 0.05, fd + 0.06, ...at(cmid, sill + 0.025), angle))
        trim.push(box(0.06, top - sill, fd, ...at(cmid - w / 2 + 0.03, (sill + top) / 2), angle))
        trim.push(box(0.06, top - sill, fd, ...at(cmid + w / 2 - 0.03, (sill + top) / 2), angle))
        // center muntin on wide windows
        if (w > 1.3) trim.push(box(0.045, top - sill - 0.1, 0.05, ...at(cmid, (sill + top) / 2), angle))
        // glass
        glass.push(box(w - 0.1, top - sill - 0.1, 0.016, ...at(cmid, (sill + top) / 2), angle, false))
      } else {
        // door / doorway / entrance: lintel above
        const top = Math.min(H, o.height)
        if (top < H) plaster.push(box(w, H - top, T, ...at(cmid, (H + top) / 2), angle))
        // frame jambs + head for real doors and doorways alike
        const fd = T + 0.024
        trim.push(box(0.07, top, fd, ...at(cmid - w / 2 + 0.02, top / 2), angle))
        trim.push(box(0.07, top, fd, ...at(cmid + w / 2 - 0.02, top / 2), angle))
        trim.push(box(w, 0.07, fd, ...at(cmid, top - 0.035), angle))
      }
    }
  }

  return {
    plaster: plaster.length ? mergeGeometries(plaster, false) : null,
    trim: trim.length ? mergeGeometries(trim, false) : null,
    glass: glass.length ? mergeGeometries(glass, false) : null,
  }
}

export default function Walls({ plan }) {
  const geoms = useMemo(() => buildWallGeometry(plan), [plan])
  const plasterMat = useMemo(
    () => surfaceMaterial('plaster', { repeat: 0.55, roughness: 1, color: '#d6d3cc' }),
    []
  )
  return (
    <group>
      {geoms.plaster && (
        <mesh geometry={geoms.plaster} material={plasterMat} castShadow receiveShadow />
      )}
      {geoms.trim && <mesh geometry={geoms.trim} material={MAT.trim} castShadow receiveShadow />}
      {geoms.glass && <mesh geometry={geoms.glass} material={glassMaterial} />}
    </group>
  )
}
