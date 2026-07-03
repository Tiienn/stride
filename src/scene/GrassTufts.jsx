// Instanced grass tufts: crossed alpha-tested quads scattered over lawns and
// plots. One draw call for thousands of blades — the single biggest step from
// "green carpet" to "ground". The blade texture is painted to a canvas at
// runtime, so nothing is downloaded.
import * as THREE from 'three'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

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

let bladeTexCache = null
function bladeTexture() {
  if (bladeTexCache) return bladeTexCache
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 128
  const ctx = c.getContext('2d')
  const r = rng('blades')
  const greens = ['#4e7c3a', '#5d8a44', '#456f33', '#6b9350', '#3f652e']
  for (let i = 0; i < 17; i++) {
    const baseX = 8 + r() * 112
    const tipX = baseX + (r() - 0.5) * 46
    const h = 52 + r() * 70
    const w = 2.2 + r() * 3.4
    ctx.fillStyle = greens[Math.floor(r() * greens.length)]
    ctx.beginPath()
    ctx.moveTo(baseX - w, 128)
    ctx.quadraticCurveTo(baseX - w * 0.4, 128 - h * 0.6, tipX, 128 - h)
    ctx.quadraticCurveTo(baseX + w * 0.4, 128 - h * 0.6, baseX + w, 128)
    ctx.closePath()
    ctx.fill()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  bladeTexCache = tex
  return tex
}

export default function GrassTufts({
  center,
  radius,
  exclude,
  count = 1500,
  seed = 'tufts',
  heightAt = null,
}) {
  const meshRef = useRef()

  const { geom, mat, transforms } = useMemo(() => {
    const p1 = new THREE.PlaneGeometry(0.55, 0.36)
    p1.translate(0, 0.17, 0)
    const p2 = p1.clone()
    p2.rotateY(Math.PI / 2)
    const geom = mergeGeometries([p1, p2], false)

    const mat = new THREE.MeshStandardMaterial({
      map: bladeTexture(),
      alphaTest: 0.4,
      side: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.2,
    })

    const r = rng(seed)
    const transforms = []
    let guard = 0
    while (transforms.length < count && guard++ < count * 4) {
      const x = center.x + (r() * 2 - 1) * radius
      const z = center.z + (r() * 2 - 1) * radius
      if (exclude && exclude(x, z)) continue
      transforms.push({
        x,
        y: heightAt ? heightAt(x, z) : 0,
        z,
        rotY: r() * Math.PI,
        s: 0.65 + r() * 0.85,
        shade: 0.82 + r() * 0.3,
      })
    }
    return { geom, mat, transforms }
  }, [center.x, center.z, radius, exclude, count, seed, heightAt])

  useLayoutEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const col = new THREE.Color()
    transforms.forEach((t, i) => {
      q.setFromAxisAngle(up, t.rotY)
      m.compose(
        new THREE.Vector3(t.x, t.y, t.z),
        q,
        new THREE.Vector3(t.s, t.s * (0.8 + (t.shade - 0.82)), t.s)
      )
      mesh.setMatrixAt(i, m)
      mesh.setColorAt(i, col.setScalar(t.shade))
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [transforms])

  if (!transforms.length) return null
  return (
    <instancedMesh
      ref={meshRef}
      args={[geom, mat, transforms.length]}
      receiveShadow
      frustumCulled={false}
    />
  )
}
