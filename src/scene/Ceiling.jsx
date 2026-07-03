// Roof slab: white ceiling face inside, slight overhang visible through windows.
import { useMemo } from 'react'
import { MAT } from '../lib/textures.js'

export default function Ceiling({ plan }) {
  const dims = useMemo(() => {
    const { minX, maxX, minZ, maxZ } = plan.bounds
    const over = 0.35
    return {
      w: maxX - minX + over * 2,
      d: maxZ - minZ + over * 2,
      x: (minX + maxX) / 2,
      z: (minZ + maxZ) / 2,
      y: plan.walls[0]?.height ?? 2.7,
    }
  }, [plan])

  return (
    <mesh
      position={[dims.x, dims.y + 0.11, dims.z]}
      material={MAT.ceiling}
      castShadow
      receiveShadow
    >
      <boxGeometry args={[dims.w, 0.22, dims.d]} />
    </mesh>
  )
}
