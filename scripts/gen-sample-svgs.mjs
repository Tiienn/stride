// Renders the sample fixtures into architectural-style SVG plan drawings.
// Run: node scripts/gen-sample-svgs.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apartmentFixture, officeFixture, siteFixture } from '../src/data/samples.js'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../public/samples')
mkdirSync(outDir, { recursive: true })

const INK = '#1a1d24'
const FONT = 'font-family="Helvetica, Arial, sans-serif"'

function renderInterior(plan, pxPerM = 42) {
  const m = 70 // margin for dimension lines
  const W = (plan.bounds.maxX - plan.bounds.minX) * pxPerM + m * 2
  const H = (plan.bounds.maxZ - plan.bounds.minZ) * pxPerM + m * 2 + 40
  const X = (x) => m + (x - plan.bounds.minX) * pxPerM
  const Y = (z) => m + (z - plan.bounds.minZ) * pxPerM
  // doors should read as swinging into the building, not out through a wall —
  // pick whichever side of the wall line is closer to the plan's center
  const centerWorld = {
    x: (plan.bounds.minX + plan.bounds.maxX) / 2,
    z: (plan.bounds.minZ + plan.bounds.maxZ) / 2,
  }
  let s = ''

  // Walls as solid spans with gaps at openings
  for (const w of plan.walls) {
    const len = Math.hypot(w.end.x - w.start.x, w.end.z - w.start.z)
    const ux = (w.end.x - w.start.x) / len
    const uz = (w.end.z - w.start.z) / len
    const at = (t) => ({ x: w.start.x + ux * t, z: w.start.z + uz * t })
    const gaps = w.openings
      .map((o) => [o.position - o.width / 2, o.position + o.width / 2, o])
      .sort((a, b) => a[0] - b[0])
    let cursor = 0
    const tPx = Math.max(3, w.thickness * pxPerM)
    for (const [a, b] of gaps) {
      if (a > cursor) s += lineSeg(at(cursor), at(a), tPx)
      cursor = Math.max(cursor, b)
    }
    if (cursor < len) s += lineSeg(at(cursor), at(len), tPx)

    // Opening symbols
    for (const [a, b, o] of gaps) {
      const pA = at(a), pB = at(b), mid = at((a + b) / 2)
      if (o.type === 'window') {
        // double thin lines across the gap
        const nx = -uz, nz = ux
        const off = Math.min(3, tPx / 3)
        for (const k of [-1, 1]) {
          s += `<line x1="${X(pA.x) + nx * off * k}" y1="${Y(pA.z) + nz * off * k}" x2="${X(pB.x) + nx * off * k}" y2="${Y(pB.z) + nz * off * k}" stroke="${INK}" stroke-width="1.4"/>`
        }
      } else if (o.type === 'door' || o.type === 'entrance') {
        // Standard door symbol: a bold leaf standing open perpendicular to the
        // wall (hinged at pA), and a thin quarter-circle arc tracing the leaf's
        // free edge from that open position back to the closed jamb at pB.
        // The wall line has two perpendicular sides the leaf can open to — pick
        // whichever lands closer to the plan's centre (i.e. swings inward).
        const rWorld = b - a
        const r = rWorld * pxPerM
        const candA = { x: pA.x - uz * rWorld, z: pA.z + ux * rWorld }
        const candB = { x: pA.x + uz * rWorld, z: pA.z - ux * rWorld }
        const dA = (candA.x - centerWorld.x) ** 2 + (candA.z - centerWorld.z) ** 2
        const dB = (candB.x - centerWorld.x) ** 2 + (candB.z - centerWorld.z) ** 2
        const leaf = dA <= dB ? candA : candB
        const leafX = X(leaf.x)
        const leafZ = Y(leaf.z)
        // The arc must be centred on the hinge (pA), so the sweep direction
        // depends on the wall's orientation — derive it from the geometry
        // rather than hard-coding, otherwise the curve bulges the wrong way.
        // In this (unflipped, y-down) pixel space, cross > 0 ⇒ clockwise sweep.
        const cross = (leaf.x - pA.x) * (pB.z - pA.z) - (leaf.z - pA.z) * (pB.x - pA.x)
        const sweep = cross > 0 ? 1 : 0
        s += `<line x1="${X(pA.x)}" y1="${Y(pA.z)}" x2="${leafX}" y2="${leafZ}" stroke="${INK}" stroke-width="${tPx}" stroke-linecap="square"/>`
        s += `<path d="M ${leafX} ${leafZ} A ${r} ${r} 0 0 ${sweep} ${X(pB.x)} ${Y(pB.z)}" fill="none" stroke="${INK}" stroke-width="1" opacity="0.8"/>`
        if (o.type === 'entrance') {
          s += `<text x="${X(mid.x)}" y="${Y(mid.z) + (uz === 0 ? 26 : 4)}" ${FONT} font-size="9" fill="#666" text-anchor="middle">ENTRY</text>`
        }
      }
    }
  }

  // Room labels
  for (const r of plan.rooms) {
    s += `<text x="${X(r.center.x)}" y="${Y(r.center.z) - 3}" ${FONT} font-size="12.5" font-weight="600" fill="${INK}" text-anchor="middle">${r.name.toUpperCase()}</text>`
    s += `<text x="${X(r.center.x)}" y="${Y(r.center.z) + 12}" ${FONT} font-size="10.5" fill="#777" text-anchor="middle">${r.area.toFixed(1)} m²</text>`
  }

  // Overall dimensions (top + left)
  const wM = plan.bounds.maxX - plan.bounds.minX
  const hM = plan.bounds.maxZ - plan.bounds.minZ
  s += dimLine(X(plan.bounds.minX), m - 28, X(plan.bounds.maxX), m - 28, `${wM.toFixed(2)} m`)
  s += dimLineV(m - 28, Y(plan.bounds.minZ), m - 28, Y(plan.bounds.maxZ), `${hM.toFixed(2)} m`)

  s += `<text x="${m}" y="${H - 18}" ${FONT} font-size="13" font-weight="700" fill="${INK}">${plan.name.toUpperCase()}</text>`
  s += `<text x="${W - m}" y="${H - 18}" ${FONT} font-size="10" fill="#888" text-anchor="end">SCALE 1:100 · ALL DIMENSIONS IN METERS</text>`
  return wrap(W, H, s)

  function lineSeg(a, b, t) {
    return `<line x1="${X(a.x)}" y1="${Y(a.z)}" x2="${X(b.x)}" y2="${Y(b.z)}" stroke="${INK}" stroke-width="${t}" stroke-linecap="square"/>`
  }
}

function renderSite(plan, pxPerM = 13) {
  const m = 80
  const b = plan.bounds
  const W = (b.maxX - b.minX) * pxPerM + m * 2
  const H = (b.maxZ - b.minZ) * pxPerM + m * 2 + 30
  const X = (x) => m + (x - b.minX) * pxPerM
  const Y = (z) => m + (z - b.minZ) * pxPerM
  const poly = plan.site.boundary
  let s = ''

  // Road band along the road edge
  const re = plan.site.roadEdge
  if (re) {
    const dx = re.end.x - re.start.x, dz = re.end.z - re.start.z
    const len = Math.hypot(dx, dz)
    const nx = -dz / len, nz = dx / len // outward-ish normal (validated by fixture authoring)
    const off = 5.5
    const p = [
      [re.start.x, re.start.z], [re.end.x, re.end.z],
      [re.end.x + nx * off, re.end.z + nz * off], [re.start.x + nx * off, re.start.z + nz * off],
    ]
    s += `<polygon points="${p.map(([x, z]) => `${X(x)},${Y(z)}`).join(' ')}" fill="#e8e8e8"/>`
    const cmx = (re.start.x + re.end.x) / 2 + nx * off * 0.55
    const cmz = (re.start.z + re.end.z) / 2 + nz * off * 0.55
    s += `<line x1="${X(re.start.x + nx * off * 0.5)}" y1="${Y(re.start.z + nz * off * 0.5)}" x2="${X(re.end.x + nx * off * 0.5)}" y2="${Y(re.end.z + nz * off * 0.5)}" stroke="#bbb" stroke-width="1.6" stroke-dasharray="14 10"/>`
    s += `<text x="${X(cmx)}" y="${Y(cmz) - 6}" ${FONT} font-size="12" fill="#999" text-anchor="middle" letter-spacing="4">ROAD</text>`
  }

  // Parcel
  s += `<polygon points="${poly.map((p) => `${X(p.x)},${Y(p.z)}`).join(' ')}" fill="#f7f5ee" stroke="${INK}" stroke-width="2.4"/>`
  // Boundary pegs + edge dimensions
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], c = poly[(i + 1) % poly.length]
    s += `<circle cx="${X(a.x)}" cy="${Y(a.z)}" r="3.5" fill="${INK}"/>`
    const len = Math.hypot(c.x - a.x, c.z - a.z)
    const mx = (a.x + c.x) / 2, mz = (a.z + c.z) / 2
    const nx = -(c.z - a.z) / len, nz = (c.x - a.x) / len
    s += `<text x="${X(mx + nx * 2.2)}" y="${Y(mz + nz * 2.2)}" ${FONT} font-size="11.5" fill="#555" text-anchor="middle">${len.toFixed(1)} m</text>`
  }
  const area = plan.site.areaM2
  const c = plan.site.centroid
  s += `<text x="${X(c.x)}" y="${Y(c.z) - 8}" ${FONT} font-size="17" font-weight="700" fill="${INK}" text-anchor="middle">LOT 42</text>`
  s += `<text x="${X(c.x)}" y="${Y(c.z) + 14}" ${FONT} font-size="13.5" fill="#666" text-anchor="middle">${Math.round(area).toLocaleString('en-US')} m²</text>`

  // North arrow
  s += `<g transform="translate(${W - 52},${58})"><circle r="20" fill="none" stroke="#999" stroke-width="1.2"/><path d="M 0 -14 L 5 8 L 0 4 L -5 8 Z" fill="${INK}"/><text y="-26" ${FONT} font-size="11" fill="#555" text-anchor="middle">N</text></g>`
  s += `<text x="${m}" y="${H - 16}" ${FONT} font-size="13" font-weight="700" fill="${INK}">${plan.name.toUpperCase()} — SITE PLAN</text>`
  return wrap(W, H, s)
}

function dimLine(x1, y, x2, y2, label) {
  return `<g stroke="#888" stroke-width="1"><line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/><line x1="${x1}" y1="${y - 5}" x2="${x1}" y2="${y + 5}"/><line x1="${x2}" y1="${y - 5}" x2="${x2}" y2="${y + 5}"/></g><text x="${(x1 + x2) / 2}" y="${y - 6}" ${FONT} font-size="11" fill="#555" text-anchor="middle">${label}</text>`
}
function dimLineV(x, y1, x2, y2, label) {
  return `<g stroke="#888" stroke-width="1"><line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}"/><line x1="${x - 5}" y1="${y1}" x2="${x + 5}" y2="${y1}"/><line x1="${x - 5}" y1="${y2}" x2="${x + 5}" y2="${y2}"/></g><text x="${x - 8}" y="${(y1 + y2) / 2}" ${FONT} font-size="11" fill="#555" text-anchor="middle" transform="rotate(-90 ${x - 8} ${(y1 + y2) / 2})">${label}</text>`
}
function wrap(W, H, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fdfdfb"/><rect x="8" y="8" width="${W - 16}" height="${H - 16}" fill="none" stroke="#ccc" stroke-width="1"/>${inner}</svg>`
}

writeFileSync(join(outDir, 'apartment.svg'), renderInterior(apartmentFixture()))
writeFileSync(join(outDir, 'office.svg'), renderInterior(officeFixture()))
writeFileSync(join(outDir, 'site.svg'), renderSite(siteFixture()))
console.log('Wrote sample SVGs to', outDir)
