// Interior world composition: architecture + lights + furniture, plus the
// grounds around the building so windows and the front door open onto
// something real.
import * as THREE from 'three'
import { useMemo } from 'react'
import Walls from './Walls.jsx'
import Floors from './Floors.jsx'
import Ceiling from './Ceiling.jsx'
import Doors from './Doors.jsx'
import RoomLights from './RoomLights.jsx'
import Furniture from './Furniture.jsx'
import { Tree, stripGeometry } from './Exterior.jsx'
import GrassTufts from './GrassTufts.jsx'
import { surfaceMaterial, groundMaterial } from '../lib/textures.js'

function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }
}

function Surroundings({ plan }) {
  const b = plan.bounds
  const cx = (b.minX + b.maxX) / 2
  const cz = (b.minZ + b.maxZ) / 2
  const w = b.maxX - b.minX
  const d = b.maxZ - b.minZ

  const { path, trees, tuftExclude } = useMemo(() => {
    // Entrance path: from the entrance door, heading away from the building
    let path = null
    for (const wall of plan.walls) {
      const o = wall.openings.find((o) => o.type === 'entrance')
      if (!o) continue
      const len = Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z)
      const ux = (wall.end.x - wall.start.x) / len
      const uz = (wall.end.z - wall.start.z) / len
      const px = wall.start.x + ux * o.position
      const pz = wall.start.z + uz * o.position
      // outward = the side pointing away from the plan center
      let nx = -uz, nz = ux
      if ((px + nx - cx) * (px + nx - cx) + (pz + nz - cz) * (pz + nz - cz) <
          (px - nx - cx) * (px - nx - cx) + (pz - nz - cz) * (pz - nz - cz)) {
        nx = -nx; nz = -nz
      }
      const plen = 7
      path = {
        x: px + nx * (plen / 2 + 0.2),
        z: pz + nz * (plen / 2 + 0.2),
        angle: Math.atan2(nz, nx),
        len: plen,
      }
      break
    }
    // A loose ring of trees around the building
    const r = rng(plan.name + 'trees')
    const trees = []
    const radius = Math.max(w, d) * 0.9 + 6
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2 + r() * 0.5
      trees.push({
        x: cx + Math.cos(a) * (radius + r() * 12),
        z: cz + Math.sin(a) * (radius + r() * 12),
        s: 0.85 + r() * 0.8,
        seed: i,
      })
    }
    // keep grass blades off the building slab and the entrance path
    const pathRef = path
    const tuftExclude = (x, z) => {
      if (x > b.minX - 2 && x < b.maxX + 2 && z > b.minZ - 2 && z < b.maxZ + 2) return true
      if (pathRef) {
        const dx = x - pathRef.x
        const dz = z - pathRef.z
        const along = dx * Math.cos(pathRef.angle) + dz * Math.sin(pathRef.angle)
        const across = -dx * Math.sin(pathRef.angle) + dz * Math.cos(pathRef.angle)
        if (Math.abs(along) < pathRef.len / 2 + 0.4 && Math.abs(across) < 1.2) return true
      }
      return false
    }
    return { path, trees, tuftExclude }
  }, [plan, cx, cz, w, d, b])

  return (
    <group>
      {/* lawn to the horizon */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[cx, -0.03, cz]}
        receiveShadow
        material={groundMaterial('lawn', { repeat: 1 / 2.2, farColor: '#5f7c45' })}
      >
        <planeGeometry args={[420, 420]} />
      </mesh>
      {/* grass blades around the building */}
      <GrassTufts
        center={{ x: cx, z: cz }}
        radius={Math.max(w, d) * 0.7 + 24}
        exclude={tuftExclude}
        count={1500}
        seed={plan.name + 'lawn'}
      />
      {/* concrete apron the building sits on */}
      <mesh position={[cx, -0.093, cz]} receiveShadow material={surfaceMaterial('concrete', { repeat: 1 / 2.4 })}>
        <boxGeometry args={[w + 2.6, 0.17, d + 2.6]} />
      </mesh>
      {/* paved path from the entrance */}
      {path && (
        <mesh
          rotation={[-Math.PI / 2, 0, -path.angle]}
          position={[path.x, -0.004, path.z]}
          receiveShadow
          material={surfaceMaterial('pavingStones', { repeat: 1.5 / 2.1 })}
          geometry={stripGeometry(path.len, 1.5)}
        />
      )}
      {trees.map((t, i) => (
        <group key={i} position={[t.x, 0, t.z]}>
          <Tree scale={t.s} seed={t.seed} />
        </group>
      ))}
    </group>
  )
}

export default function InteriorWorld({ plan }) {
  return (
    <group>
      <Walls plan={plan} />
      <Floors plan={plan} />
      <Ceiling plan={plan} />
      <Doors plan={plan} />
      <RoomLights plan={plan} />
      <Furniture plan={plan} />
      <Surroundings plan={plan} />
    </group>
  )
}
