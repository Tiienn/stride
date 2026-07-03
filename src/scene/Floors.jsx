// Per-room floors, merged into one mesh per finish. Hard floors (wood, tile)
// get real planar reflections via MeshReflectorMaterial on the high tier —
// the single biggest "this isn't a demo" cue.
import * as THREE from 'three'
import { useMemo } from 'react'
import { MeshReflectorMaterial } from '@react-three/drei'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { surfaceMaps, surfaceMaterial } from '../lib/textures.js'
import { roomConfig } from '../lib/roomTypes.js'
import { useStride } from '../store.js'

// Texture world size (meters covered by one tile) per finish
const TEX_SIZE = {
  woodFloor: 2.1,
  tiles: 1.7,
  carpet: 2.6,
  concrete: 2.4,
  pavingStones: 2.1,
}
const REFLECTIVE = { woodFloor: 0.5, tiles: 0.85 }
// Subtle tints so pale source photos read as real finishes under our light
const TINT = { woodFloor: '#e2c9a5', carpet: '#cfd2d6' }

// A rect floor patch with world-space UVs so tiling is continuous across rooms
function rectGeom(x, z, w, d, y = 0) {
  const g = new THREE.BufferGeometry()
  // wound counter-clockwise seen from above (+y), so the face isn't culled
  const verts = new Float32Array([
    x, y, z,   x + w, y, z + d,   x + w, y, z,
    x, y, z,   x, y, z + d,   x + w, y, z + d,
  ])
  const uvs = new Float32Array([
    x, z,   x + w, z + d,   x + w, z,
    x, z,   x, z + d,   x + w, z + d,
  ])
  const normals = new Float32Array(18)
  for (let i = 0; i < 6; i++) normals[i * 3 + 1] = 1
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  return g
}

export default function Floors({ plan }) {
  const quality = useStride((s) => s.quality)

  const groups = useMemo(() => {
    const byFinish = new Map()
    for (const room of plan.rooms) {
      const finish = roomConfig(room.type).floor
      if (!byFinish.has(finish)) byFinish.set(finish, [])
      for (const r of room.floorRects) byFinish.get(finish).push(rectGeom(r.x, r.z, r.w, r.d))
    }
    return [...byFinish.entries()].map(([finish, geoms]) => ({
      finish,
      geometry: mergeGeometries(geoms, false),
    }))
  }, [plan])

  return (
    <group>
      {groups.map(({ finish, geometry }) => {
        const repeat = 1 / (TEX_SIZE[finish] || 2)
        const reflective = quality === 'high' && REFLECTIVE[finish]
        if (reflective) {
          const maps = surfaceMaps(finish, repeat)
          return (
            <mesh key={finish} geometry={geometry} receiveShadow>
              <MeshReflectorMaterial
                {...maps}
                color={TINT[finish] || '#ffffff'}
                resolution={512}
                blur={[260, 90]}
                mixBlur={0.85}
                mixStrength={REFLECTIVE[finish]}
                mixContrast={1}
                depthScale={0.5}
                minDepthThreshold={0.6}
                maxDepthThreshold={1.6}
                roughness={finish === 'tiles' ? 0.35 : 0.6}
                reflectorOffset={0.001}
              />
            </mesh>
          )
        }
        return (
          <mesh
            key={finish}
            geometry={geometry}
            material={surfaceMaterial(finish, { repeat, ...(TINT[finish] ? { color: TINT[finish] } : {}) })}
            receiveShadow
          />
        )
      })}
    </group>
  )
}
