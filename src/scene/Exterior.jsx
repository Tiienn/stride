// The site-plan world: the surveyed parcel with pegs and string lines, mown
// grass inside the boundary, wilder ground beyond, an access road along the
// road edge, and a scattering of trees. Everything sized from the real plan.
import * as THREE from 'three'
import { useMemo } from 'react'
import { Line } from '@react-three/drei'
import {
  surfaceMaterial,
  groundMaterial,
  proceduralGroundMaterial,
  MAT,
  plainMaterial,
} from '../lib/textures.js'
import { pointInPolygon } from '../lib/planProcess.js'
import { makeTerrain } from '../lib/terrain.js'
import { useStride } from '../store.js'
import GrassTufts from './GrassTufts.jsx'
import GrassField from './GrassField.jsx'

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

// --- procedural trees -------------------------------------------------------
// Perfect spheres read as broccoli. The canopy is built from a small cache of
// noise-displaced sphere variants (lumpy, irregular silhouettes), many small
// blobs instead of a few big ones, over a tapered, slightly bent trunk with
// real branches. Two species — rounded and columnar — so a treeline varies.

const barkMat = plainMaterial({ color: '#54432f', roughness: 0.95 })
const foliageMats = [
  plainMaterial({ color: '#48653a', roughness: 1, envMapIntensity: 0.25 }),
  plainMaterial({ color: '#546f3d', roughness: 1, envMapIntensity: 0.25 }),
  plainMaterial({ color: '#3c5a33', roughness: 1, envMapIntensity: 0.25 }),
  plainMaterial({ color: '#5d7a45', roughness: 1, envMapIntensity: 0.25 }),
]

let blobVariants = null
function getBlobVariants() {
  if (blobVariants) return blobVariants
  blobVariants = []
  for (let v = 0; v < 4; v++) {
    const g = new THREE.SphereGeometry(1, 11, 8)
    const pos = g.attributes.position
    const vec = new THREE.Vector3()
    for (let i = 0; i < pos.count; i++) {
      vec.fromBufferAttribute(pos, i)
      // deterministic hash noise along the normal — lumpy, never smooth
      const n =
        Math.sin(vec.x * 12.9898 + vec.y * 78.233 + vec.z * 37.719 + v * 17.1) * 43758.5453
      const d = 1 + (n - Math.floor(n) - 0.5) * 0.42
      vec.multiplyScalar(d)
      pos.setXYZ(i, vec.x, vec.y * 0.88, vec.z)
    }
    g.computeVertexNormals()
    blobVariants.push(g)
  }
  return blobVariants
}

export function Tree({ scale = 1, seed = 1 }) {
  const { parts, blobs } = useMemo(() => {
    const r = rng(`tree${seed}`)
    const columnar = r() > 0.68 // a few tall, narrow trees vary the skyline
    const lean = (r() - 0.5) * 0.16
    const trunkH = columnar ? 2.0 : 2.6

    const parts = {
      columnar,
      lean,
      trunkH,
      branches: Array.from({ length: columnar ? 2 : 3 }, () => ({
        angle: r() * Math.PI * 2,
        tilt: 0.5 + r() * 0.45,
        len: 1.1 + r() * 0.8,
        y: trunkH * (0.72 + r() * 0.2),
      })),
    }

    const n = columnar ? 9 : 13
    const rx = columnar ? 0.85 : 1.55
    const ry = columnar ? 2.1 : 1.15
    const cy = columnar ? trunkH + 1.9 : trunkH + 1.15
    const blobs = Array.from({ length: n }, (_, i) => {
      // cluster inside an ellipsoid, denser toward the middle
      const a = r() * Math.PI * 2
      const b = (r() - 0.5) * Math.PI
      const rad = Math.pow(r(), 0.6)
      return {
        x: Math.cos(a) * Math.cos(b) * rx * rad + lean * 2,
        y: cy + Math.sin(b) * ry * rad,
        z: Math.sin(a) * Math.cos(b) * rx * rad,
        s: (columnar ? 0.5 : 0.55) + r() * 0.5,
        rot: r() * Math.PI * 2,
        variant: i % 4,
        mat: Math.floor(r() * foliageMats.length),
      }
    })
    return { parts, blobs }
  }, [seed])

  const variants = getBlobVariants()

  return (
    <group scale={scale}>
      {/* trunk: two tapered segments with a slight bend */}
      <mesh castShadow material={barkMat} position={[0, parts.trunkH * 0.35, 0]} rotation={[0, 0, parts.lean * 0.5]}>
        <cylinderGeometry args={[0.15, 0.24, parts.trunkH * 0.7, 8]} />
      </mesh>
      <mesh
        castShadow
        material={barkMat}
        position={[parts.lean * 0.9, parts.trunkH * 0.82, 0]}
        rotation={[0, 0, parts.lean * 1.6]}
      >
        <cylinderGeometry args={[0.09, 0.15, parts.trunkH * 0.65, 8]} />
      </mesh>
      {/* main branches reaching into the canopy */}
      {parts.branches.map((b, i) => (
        <mesh
          key={i}
          castShadow
          material={barkMat}
          position={[
            Math.cos(b.angle) * b.len * 0.32,
            b.y + b.len * 0.35,
            Math.sin(b.angle) * b.len * 0.32,
          ]}
          rotation={[Math.sin(b.angle) * b.tilt, 0, -Math.cos(b.angle) * b.tilt]}
        >
          <cylinderGeometry args={[0.035, 0.07, b.len, 6]} />
        </mesh>
      ))}
      {/* canopy */}
      {blobs.map((b, i) => (
        <mesh
          key={i}
          castShadow
          geometry={variants[b.variant]}
          material={foliageMats[b.mat]}
          position={[b.x, b.y, b.z]}
          rotation={[0, b.rot, 0]}
          scale={b.s}
        />
      ))}
    </group>
  )
}

const pegMat = plainMaterial({ color: '#c8b28c', roughness: 0.9 })
const pegTop = plainMaterial({ color: '#d84a3a', roughness: 0.7 })
const flagMat = plainMaterial({ color: '#e8b74a', roughness: 0.6, side: THREE.DoubleSide })
const poleMat = plainMaterial({ color: '#8a8378', roughness: 0.5, metalness: 0.4 })
const lineMat = { color: '#f5f2e8' }

// A long thin plane's default UVs stretch a texture ~len/width times along
// it — the source of the smeared road shoulder. Scale UV.x so one texture
// tile covers the same distance in both directions.
export function stripGeometry(len, wid) {
  const g = new THREE.PlaneGeometry(len, wid)
  const uv = g.attributes.uv
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * (len / wid))
  return g
}

// Self-contained text label (canvas texture — no font downloads)
function makeLabelTexture(text) {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 96
  const ctx = c.getContext('2d')
  ctx.fillStyle = 'rgba(14, 15, 18, 0.72)'
  const w = 190, h = 60, x = (256 - w) / 2, y = (96 - h) / 2, r = 30
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
  ctx.fill()
  ctx.font = '700 34px -apple-system, Helvetica, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#f2efe6'
  ctx.fillText(text, 128, 50)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

function EdgeLabel({ position, text }) {
  const tex = useMemo(() => makeLabelTexture(text), [text])
  return (
    <sprite position={position} scale={[2.6, 0.975, 1]}>
      <spriteMaterial map={tex} transparent depthWrite={false} />
    </sprite>
  )
}

export default function SiteWorld({ plan }) {
  const site = plan.site
  const boundary = site.boundary

  const { plotGeom, roadData, trees } = useMemo(() => {
    // Plot surface (world-UV shape). Author in (x, -z) so a -90° X rotation
    // lands at (x, 0, z) with normals up and correct winding.
    const shape = new THREE.Shape(boundary.map((p) => new THREE.Vector2(p.x, -p.z)))
    const plotGeom = new THREE.ShapeGeometry(shape)
    plotGeom.rotateX(-Math.PI / 2)

    // Road along the road edge, offset outward
    let roadData = null
    if (site.roadEdge) {
      const { start, end } = site.roadEdge
      const u = new THREE.Vector3(end.x - start.x, 0, end.z - start.z)
      const len = u.length()
      u.normalize()
      const mid = new THREE.Vector3((start.x + end.x) / 2, 0, (start.z + end.z) / 2)
      const c = site.centroid
      let n = new THREE.Vector3(mid.x - c.x, 0, mid.z - c.z)
      n.sub(u.clone().multiplyScalar(n.dot(u))).normalize()
      const angle = Math.atan2(u.z, u.x)
      const shoulderC = mid.clone().add(n.clone().multiplyScalar(1.0))
      const roadC = mid.clone().add(n.clone().multiplyScalar(2.0 + 2.75))
      roadData = { angle, len: len + 36, shoulderC, roadC, u, n, mid }
    }

    // Trees: scattered outside the plot, clear of the road
    const r = rng(plan.name)
    const span = Math.max(plan.bounds.maxX - plan.bounds.minX, plan.bounds.maxZ - plan.bounds.minZ)
    const trees = []
    let guard = 0
    while (trees.length < 16 && guard++ < 300) {
      const a = r() * Math.PI * 2
      const rad = span * 0.62 + r() * span * 0.65
      const x = site.centroid.x + Math.cos(a) * rad
      const z = site.centroid.z + Math.sin(a) * rad
      if (pointInPolygon({ x, z }, boundary)) continue
      if (roadData) {
        const rel = new THREE.Vector3(x - roadData.mid.x, 0, z - roadData.mid.z)
        const dPerp = rel.dot(roadData.n)
        if (dPerp > -3 && dPerp < 12) continue // road corridor
      }
      trees.push({ x, z, s: 0.8 + r() * 0.9, seed: trees.length })
    }
    // one or two inside, toward the back
    if (roadData) {
      const back = site.centroid.x !== undefined
        ? { x: site.centroid.x - roadData.n.x * span * 0.28, z: site.centroid.z - roadData.n.z * span * 0.28 }
        : site.centroid
      if (pointInPolygon(back, boundary)) trees.push({ x: back.x, z: back.z, s: 1.1, seed: 99 })
    }
    return { plotGeom, roadData, trees }
  }, [plan, boundary, site])

  // The parcel's ground base — a look decision, so it's switchable
  const plotStyle = useStride((s) => s.plotStyle)
  const mownGrass = useMemo(() => {
    switch (plotStyle) {
      case 'meadow': // dry golden field — super-white tint bleaches the olive
        return groundMaterial('meadow', { repeat: 1 / 2.9, tint: [1.5, 1.32, 0.8], farColor: '#8f8660' })
      case 'lawn': // fresh mown green
        return groundMaterial('lawn', { repeat: 1 / 2.2, farColor: '#5f7c45' })
      default: // 'cleared': graded earth with patchy regrowth
        return groundMaterial('earthPatchy', { repeat: 1 / 3.4, farColor: '#7d7757' })
    }
  }, [plotStyle])
  // Ground beyond the boundary: rolling terrain with photo-free procedural
  // color, carpeted by the instanced grass field. No repeated photo at all.
  const terrain = useMemo(() => makeTerrain(plan), [plan])
  const wildGrass = useMemo(() => proceduralGroundMaterial(), [])
  const terrainGeom = useMemo(() => {
    const size = 500
    const segs = 170
    const g = new THREE.PlaneGeometry(size, size, segs, segs)
    g.rotateX(-Math.PI / 2)
    const pos = g.attributes.position
    const cx = site.centroid.x
    const cz = site.centroid.z
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + cx
      const wz = pos.getZ(i) + cz
      pos.setY(i, terrain.heightAt(wx, wz))
    }
    g.computeVertexNormals()
    return g
  }, [terrain, site])

  // grass tufts everywhere except the road corridor
  const tuftData = useMemo(() => {
    const span = Math.max(plan.bounds.maxX - plan.bounds.minX, plan.bounds.maxZ - plan.bounds.minZ)
    // Tufts belong to the wild surroundings only: the parcel itself reads
    // mown, and the road corridor stays clear.
    const exclude = (x, z) => {
      if (pointInPolygon({ x, z }, boundary)) return true
      if (roadData) {
        const rel = { x: x - roadData.mid.x, z: z - roadData.mid.z }
        const dPerp = rel.x * roadData.n.x + rel.z * roadData.n.z
        if (dPerp > 0.3 && dPerp < 8.5) return true
      }
      return false
    }
    return { center: site.centroid, radius: span * 0.8 + 12, exclude }
  }, [plan, site, roadData, boundary])

  return (
    <group>
      {/* Rolling wild ground to the horizon (flat under plot + road) */}
      <mesh
        geometry={terrainGeom}
        position={[site.centroid.x, -0.02, site.centroid.z]}
        receiveShadow
        material={wildGrass}
      />
      {/* Dense wind-blown grass over the wild land */}
      <GrassField terrain={terrain} exclude={tuftData.exclude} />
      {/* The parcel itself — mown, slightly proud of the surroundings */}
      <mesh geometry={plotGeom} position={[0, 0.02, 0]} receiveShadow material={mownGrass} />

      {/* Boundary pegs with survey flags + string line */}
      {boundary.map((p, i) => (
        <group key={i} position={[p.x, 0, p.z]}>
          <mesh castShadow material={pegMat} position={[0, 0.28, 0]}>
            <boxGeometry args={[0.09, 0.56, 0.09]} />
          </mesh>
          <mesh material={pegTop} position={[0, 0.54, 0]}>
            <boxGeometry args={[0.095, 0.06, 0.095]} />
          </mesh>
          {/* flag pole — visible from across the plot, the peg alone isn't */}
          <mesh castShadow material={poleMat} position={[0, 0.85, 0]}>
            <cylinderGeometry args={[0.012, 0.012, 1.7, 8]} />
          </mesh>
          <mesh
            castShadow
            material={flagMat}
            position={[0.17, 1.6, 0]}
            rotation={[0, 0, -Math.PI / 2]}
          >
            <coneGeometry args={[0.1, 0.34, 3]} />
          </mesh>
        </group>
      ))}
      <Line
        points={[...boundary, boundary[0]].map((p) => [p.x, 0.42, p.z])}
        color={lineMat.color}
        lineWidth={1.5}
        transparent
        opacity={0.9}
      />
      {/* Edge lengths, floating over each boundary side — the 2D plan's
          numbers, standing in the world they describe */}
      {boundary.map((a, i) => {
        const b = boundary[(i + 1) % boundary.length]
        const len = Math.hypot(b.x - a.x, b.z - a.z)
        return (
          <EdgeLabel
            key={`len-${i}`}
            position={[(a.x + b.x) / 2, 1.45, (a.z + b.z) / 2]}
            text={`${len.toFixed(1)} m`}
          />
        )
      })}

      {/* Road */}
      {roadData && (
        <group>
          <mesh
            rotation={[-Math.PI / 2, 0, -roadData.angle]}
            position={[roadData.shoulderC.x, 0.002, roadData.shoulderC.z]}
            receiveShadow
            material={groundMaterial('ground', { repeat: 2.4 / 1.8 })}
            geometry={stripGeometry(roadData.len, 2.4)}
          />
          <mesh
            rotation={[-Math.PI / 2, 0, -roadData.angle]}
            position={[roadData.roadC.x, 0.004, roadData.roadC.z]}
            receiveShadow
            material={surfaceMaterial('asphalt', { repeat: 5.5 / 4 })}
            geometry={stripGeometry(roadData.len, 5.5)}
          />
          {/* dashed centerline */}
          {Array.from({ length: Math.floor(roadData.len / 4) }, (_, i) => {
            const t = (i - Math.floor(roadData.len / 4) / 2) * 4
            return (
              <mesh
                key={i}
                rotation={[-Math.PI / 2, 0, -roadData.angle]}
                position={[
                  roadData.roadC.x + roadData.u.x * t,
                  0.006,
                  roadData.roadC.z + roadData.u.z * t,
                ]}
                material={MAT.white}
              >
                <planeGeometry args={[1.8, 0.12]} />
              </mesh>
            )
          })}
        </group>
      )}

      {/* Larger clumps for mid-distance texture */}
      <GrassTufts
        center={tuftData.center}
        radius={tuftData.radius}
        exclude={tuftData.exclude}
        count={1200}
        seed={plan.name}
        heightAt={terrain.heightAt}
      />

      {/* Trees */}
      {trees.map((t, i) => (
        <group key={i} position={[t.x, terrain.heightAt(t.x, t.z), t.z]}>
          <Tree scale={t.s} seed={t.seed} />
        </group>
      ))}
    </group>
  )
}
