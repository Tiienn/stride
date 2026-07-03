// Dense instanced grass field. A 3×3 grid of chunks follows the player;
// each chunk packs thousands of tapered blades placed deterministically per
// world cell (so re-entering an area regrows identical grass), positioned on
// the real terrain height, excluded from the plot and road. Blades sway in
// the wind on the GPU — matrices only change when the player crosses a cell.
import * as THREE from 'three'
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useStride } from '../store.js'

const CELL = 18 // meters per chunk
const BLADES_PER_M2 = { high: 9, medium: 4.5, low: 1.8 }

function cellHash(cx, cz, i) {
  let h = cx * 374761393 + cz * 668265263 + i * 1274126177
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

// Tapered, slightly curved blade with a dark→light vertical color ramp
function bladeGeometry() {
  const g = new THREE.PlaneGeometry(0.075, 0.42, 1, 3)
  g.translate(0, 0.21, 0)
  const pos = g.attributes.position
  const colors = new Float32Array(pos.count * 3)
  const base = new THREE.Color('#3c5c2c')
  const tip = new THREE.Color('#7fa34e')
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 0.42
    // taper toward the tip + gentle forward curve
    pos.setX(i, pos.getX(i) * (1 - y * 0.82))
    pos.setZ(i, pos.getZ(i) + y * y * 0.09)
    c.lerpColors(base, tip, y)
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return g
}

export default function GrassField({ terrain, exclude }) {
  const quality = useStride((s) => s.quality)
  const camera = useThree((s) => s.camera)
  const meshes = useRef([]) // 9 InstancedMesh refs
  const assignment = useRef(new Map()) // "cx,cz" -> mesh index
  const shaderRef = useRef(null)
  const lastCell = useRef(null)

  const density = BLADES_PER_M2[quality] ?? 4.5
  const capacity = Math.ceil(CELL * CELL * density)

  const { geom, mat } = useMemo(() => {
    const geom = bladeGeometry()
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.25,
    })
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 }
      shaderRef.current = shader
      shader.vertexShader =
        'uniform float uTime;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          {
            // wind: tips sway, roots hold. Phase varies across the field.
            float bladeH = clamp( position.y / 0.42, 0.0, 1.0 );
            #ifdef USE_INSTANCING
              float phase = instanceMatrix[3][0] * 0.43 + instanceMatrix[3][2] * 0.31;
            #else
              float phase = 0.0;
            #endif
            float sway = sin( uTime * 1.9 + phase ) * 0.6 + sin( uTime * 3.7 + phase * 1.7 ) * 0.25;
            transformed.x += sway * 0.13 * bladeH * bladeH;
          }`
        )
    }
    return { geom, mat }
  }, [])

  // (Re)fill one chunk's instances for a given world cell
  const fillChunk = useMemo(() => {
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const p = new THREE.Vector3()
    const s = new THREE.Vector3()
    const col = new THREE.Color()
    return (mesh, cx, cz) => {
      let n = 0
      for (let i = 0; i < capacity; i++) {
        const x = (cx + cellHash(cx, cz, i * 3)) * CELL
        const z = (cz + cellHash(cx, cz, i * 3 + 1)) * CELL
        if (exclude && exclude(x, z)) continue
        const r = cellHash(cx, cz, i * 3 + 2)
        const scale = 0.65 + r * 0.9
        p.set(x, terrain.heightAt(x, z), z)
        q.setFromAxisAngle(up, r * Math.PI * 2)
        s.set(scale, scale * (0.85 + r * 0.5), scale)
        m.compose(p, q, s)
        mesh.setMatrixAt(n, m)
        mesh.setColorAt(n, col.setScalar(0.8 + cellHash(cz, cx, i) * 0.4))
        n++
      }
      mesh.count = n
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  }, [capacity, exclude, terrain])

  // Track the player's cell; refill only chunks whose cell changed
  useFrame((state, dt) => {
    if (shaderRef.current) shaderRef.current.uniforms.uTime.value += dt
    const ccx = Math.floor(camera.position.x / CELL)
    const ccz = Math.floor(camera.position.z / CELL)
    const key = `${ccx},${ccz}`
    if (lastCell.current === key) return
    lastCell.current = key

    const wanted = []
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) wanted.push(`${ccx + dx},${ccz + dz}`)

    const current = assignment.current
    // free meshes of cells no longer wanted
    const freeIdx = []
    for (const [cellKey, idx] of [...current.entries()]) {
      if (!wanted.includes(cellKey)) {
        current.delete(cellKey)
        freeIdx.push(idx)
      }
    }
    const usedIdx = new Set(current.values())
    for (let i = 0; i < 9; i++) if (!usedIdx.has(i) && !freeIdx.includes(i)) freeIdx.push(i)
    // fill newly wanted cells
    for (const cellKey of wanted) {
      if (current.has(cellKey)) continue
      const idx = freeIdx.pop()
      if (idx === undefined) break
      const mesh = meshes.current[idx]
      if (!mesh) continue
      const [cx, cz] = cellKey.split(',').map(Number)
      fillChunk(mesh, cx, cz)
      current.set(cellKey, idx)
    }
  })

  // force refill when quality/exclude changes
  useEffect(() => {
    assignment.current.clear()
    lastCell.current = null
  }, [capacity, fillChunk])

  return (
    <group>
      {Array.from({ length: 9 }, (_, i) => (
        <instancedMesh
          key={`${i}-${capacity}`}
          ref={(el) => (meshes.current[i] = el)}
          args={[geom, mat, capacity]}
          receiveShadow
          frustumCulled={false}
        />
      ))}
    </group>
  )
}
