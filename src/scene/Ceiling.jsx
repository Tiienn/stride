// Roof slab: white ceiling face inside, slight overhang visible through
// windows. When the plan has outdoor rooms (balconies, terraces), the slab is
// built from grid rects covering only walls + indoor rooms, so those spaces
// stay open to the sky.
import { useMemo } from 'react'
import { MAT } from '../lib/textures.js'
import { ceilingRects } from '../lib/planProcess.js'

export default function Ceiling({ plan }) {
  const y = (plan.walls[0]?.height ?? 2.7) + 0.11
  const rects = useMemo(() => ceilingRects(plan), [plan])

  const slab = useMemo(() => {
    const { minX, maxX, minZ, maxZ } = plan.bounds
    const over = 0.35
    return {
      w: maxX - minX + over * 2,
      d: maxZ - minZ + over * 2,
      x: (minX + maxX) / 2,
      z: (minZ + maxZ) / 2,
    }
  }, [plan])

  if (rects) {
    return (
      <group>
        {rects.map((r, i) => (
          <mesh
            key={i}
            position={[r.x + r.w / 2, y, r.z + r.d / 2]}
            material={MAT.ceiling}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[r.w, 0.22, r.d]} />
          </mesh>
        ))}
      </group>
    )
  }

  return (
    <mesh position={[slab.x, y, slab.z]} material={MAT.ceiling} castShadow receiveShadow>
      <boxGeometry args={[slab.w, 0.22, slab.d]} />
    </mesh>
  )
}
