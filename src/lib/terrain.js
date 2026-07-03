// Rolling terrain for site plans. One seeded height function drives
// everything — the displaced ground mesh, the player's feet, trees, tufts
// and the grass field all query the same numbers, so nothing floats.
//
// The plot itself (and a margin around it, and the road corridor) is held
// perfectly flat: the parcel is surveyed ground; the wilderness rolls.

function makeHash(seed) {
  return (xi, yi) => {
    let h = xi * 374761393 + yi * 668265263 + seed * 974711
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    h ^= h >>> 16
    return (h >>> 0) / 4294967296
  }
}

const smooth = (t) => t * t * t * (t * (t * 6 - 15) + 10)

function makeValueNoise(seed) {
  const hash = makeHash(seed)
  return (x, y) => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const fx = smooth(x - xi)
    const fy = smooth(y - yi)
    const a = hash(xi, yi)
    const b = hash(xi + 1, yi)
    const c = hash(xi, yi + 1)
    const d = hash(xi + 1, yi + 1)
    return (a + (b - a) * fx + (c + (d - c) * fx - (a + (b - a) * fx)) * fy) * 2 - 1
  }
}

function distToSegment(px, pz, ax, az, bx, bz) {
  const abx = bx - ax
  const abz = bz - az
  const lenSq = abx * abx + abz * abz || 1e-9
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / lenSq))
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t))
}

function pointInPoly(x, z, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

const clamp01 = (v) => Math.min(1, Math.max(0, v))
const smoothstep = (a, b, v) => {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}

export function makeTerrain(plan) {
  if (plan.planType !== 'site' || !plan.site?.boundary?.length) {
    return { heightAt: () => 0, rolling: false }
  }
  const boundary = plan.site.boundary
  // deterministic seed from the plan name
  let seed = 7
  for (let i = 0; i < plan.name.length; i++) seed = (seed * 31 + plan.name.charCodeAt(i)) | 0

  const n1 = makeValueNoise(seed)
  const n2 = makeValueNoise(seed ^ 0x9e3779b9)
  const n3 = makeValueNoise(seed ^ 0x85ebca6b)

  const road = plan.site.roadEdge

  const flattenFactor = (x, z) => {
    if (pointInPoly(x, z, boundary)) return 0
    // distance to the nearest boundary edge
    let d = Infinity
    for (let i = 0; i < boundary.length; i++) {
      const a = boundary[i]
      const b = boundary[(i + 1) % boundary.length]
      d = Math.min(d, distToSegment(x, z, a.x, a.z, b.x, b.z))
    }
    let f = smoothstep(5, 26, d)
    if (road) {
      // the road cuts a flat corridor through the rolling ground
      const dr = distToSegment(
        x, z,
        road.start.x - (road.end.x - road.start.x) * 0.4,
        road.start.z - (road.end.z - road.start.z) * 0.4,
        road.end.x + (road.end.x - road.start.x) * 0.4,
        road.end.z + (road.end.z - road.start.z) * 0.4
      )
      f *= smoothstep(9, 20, dr)
    }
    return f
  }

  const heightAt = (x, z) => {
    const f = flattenFactor(x, z)
    if (f <= 0) return 0
    const h =
      n1(x / 46, z / 46) * 1.0 +
      n2(x / 17, z / 17) * 0.35 +
      n3(x / 7.3, z / 7.3) * 0.12
    return h * 1.15 * f
  }

  return { heightAt, flattenFactor, rolling: true }
}
