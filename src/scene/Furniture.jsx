// Auto-furnishing. Rooms get furniture layouts by type, placed against real
// walls, clear of door swings, inside the room's actual (grid-verified)
// footprint, with collision registered so the player can't walk through.
import { useEffect, useMemo } from 'react'
import * as P from './furniture/pieces.jsx'
import { roomConfig } from '../lib/roomTypes.js'
import { registerCollider } from '../lib/interact.js'
import { repairCirculation } from '../lib/circulation.js'

// Deterministic per-room randomness — same plan always furnishes the same way
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

const EDGES = ['N', 'S', 'W', 'E'] // N = minZ wall, S = maxZ, W = minX, E = maxX

function edgeGeometry(room, edge) {
  const { minX, maxX, minZ, maxZ } = room.bbox
  switch (edge) {
    case 'N': return { axis: 'x', from: minX, to: maxX, line: minZ, inward: 1, rotY: Math.PI }
    case 'S': return { axis: 'x', from: minX, to: maxX, line: maxZ, inward: -1, rotY: 0 }
    case 'W': return { axis: 'z', from: minZ, to: maxZ, line: minX, inward: 1, rotY: -Math.PI / 2 }
    case 'E': return { axis: 'z', from: minZ, to: maxZ, line: maxX, inward: -1, rotY: Math.PI / 2 }
  }
}

// Openings (doors/windows) projected onto a room's bbox edges + door zones
function analyzeRoom(plan, room) {
  const edges = {}
  for (const e of EDGES) edges[e] = { ...edgeGeometry(room, e), blocked: [] }
  const doorZones = []

  for (const wall of plan.walls) {
    const horizontal = Math.abs(wall.start.z - wall.end.z) < 0.05
    const vertical = Math.abs(wall.start.x - wall.end.x) < 0.05
    if (!horizontal && !vertical) continue
    const len = Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z)
    const ux = (wall.end.x - wall.start.x) / len
    const uz = (wall.end.z - wall.start.z) / len
    for (const o of wall.openings) {
      const cx = wall.start.x + ux * o.position
      const cz = wall.start.z + uz * o.position
      const isDoor = o.type !== 'window'
      // Keep-clear zones are rectangles in front of the opening: full width
      // along the wall, limited depth into the room. Hinged doors get swing
      // depth; plain doorways just passage depth.
      const hasSwing = o.type === 'door' || o.type === 'entrance'
      if (isDoor) {
        const halfW = o.width / 2 + (hasSwing ? 0.35 : 0.15)
        const depth = hasSwing ? 1.05 : 0.6
        if (horizontal) {
          doorZones.push({ minX: cx - halfW, maxX: cx + halfW, minZ: cz - depth, maxZ: cz + depth })
        } else {
          doorZones.push({ minX: cx - depth, maxX: cx + depth, minZ: cz - halfW, maxZ: cz + halfW })
        }
      }
      for (const e of EDGES) {
        const g = edges[e]
        const lineCoord = g.axis === 'x' ? cz : cx
        const spanCoord = g.axis === 'x' ? cx : cz
        if (Math.abs(lineCoord - g.line) > 0.4) continue
        const margin = hasSwing ? 0.45 : isDoor ? 0.2 : 0.06
        g.blocked.push({
          from: spanCoord - o.width / 2 - margin,
          to: spanCoord + o.width / 2 + margin,
          tallOnly: !isDoor, // low furniture may sit under a window
          sill: o.sillHeight ?? 0,
        })
      }
    }
  }
  return { edges, doorZones }
}

function cellIsRoom(plan, room, x, z) {
  const g = plan.grid
  const cx = Math.floor((x - g.originX) / g.cell)
  const cy = Math.floor((z - g.originZ) / g.cell)
  if (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h) return false
  return g.cells[cy * g.w + cx] === room.gridIndex
}

function aabbIntersects(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ
}

function makePlacer(plan, room, info, rand) {
  const placed = []
  const items = []

  function fits(aabb, { height = 1, walkable = false, ignorePlaced = false } = {}) {
    // corners + center must sit in this room's cells
    const pts = [
      [aabb.minX + 0.03, aabb.minZ + 0.03], [aabb.maxX - 0.03, aabb.minZ + 0.03],
      [aabb.minX + 0.03, aabb.maxZ - 0.03], [aabb.maxX - 0.03, aabb.maxZ - 0.03],
      [(aabb.minX + aabb.maxX) / 2, (aabb.minZ + aabb.maxZ) / 2],
    ]
    for (const [x, z] of pts) if (!cellIsRoom(plan, room, x, z)) return false
    if (!walkable) {
      // ignorePlaced: chairs tuck into desks/tables — furniture overlap is fine
      if (!ignorePlaced) for (const p of placed) if (aabbIntersects(aabb, p)) return false
      for (const dz of info.doorZones) if (aabbIntersects(aabb, dz)) return false
    }
    return true
  }

  function commit(Comp, props, x, z, rotY, foot, opts = {}) {
    const rotated = Math.abs(Math.sin(rotY)) > 0.5
    const w = rotated ? foot.d : foot.w
    const d = rotated ? foot.w : foot.d
    const aabb = { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 }
    items.push({ Comp, props, x, z, rotY, aabb, walkable: foot.walkable || opts.walkable })
    if (!foot.walkable && !opts.walkable) placed.push(aabb)
    return { x, z, rotY, aabb }
  }

  // Place an item with its back against a wall edge. Computes the actual
  // free spans between openings (rather than stepping fixed-size candidates
  // across the whole edge) so narrow gaps between doors/windows are found
  // reliably instead of missed.
  function againstEdge(Comp, props, footArgs, edgePref, opts = {}) {
    const foot = Comp.foot(...(footArgs || []))
    const height = opts.height ?? 1.2
    const edgeOrder = edgePref
      ? [...edgePref, ...EDGES.filter((e) => !edgePref.includes(e))]
      : [...EDGES].sort(() => rand() - 0.5)
    for (const e of edgeOrder) {
      const g = info.edges[e]
      const edgeLen = g.to - g.from
      if (edgeLen < foot.w + 0.1) continue
      const inset = g.line + g.inward * (foot.d / 2 + 0.04)

      const blocked = g.blocked
        .filter((b) => !(b.tallOnly && height <= Math.max(0.85, b.sill - 0.05)))
        .map((b) => [Math.max(g.from, b.from), Math.min(g.to, b.to)])
        .filter(([a, b]) => b > a)
        .sort((a, b) => a[0] - b[0])
      const free = []
      let cursor = g.from
      for (const [a, b] of blocked) {
        if (a > cursor) free.push([cursor, a])
        cursor = Math.max(cursor, b)
      }
      if (cursor < g.to) free.push([cursor, g.to])
      // widest free span first — most likely to fit and least cramped
      free.sort((s1, s2) => s2[1] - s2[0] - (s1[1] - s1[0]))

      for (const [a, b] of free) {
        if (b - a < foot.w + 0.06) continue
        const center = (a + b) / 2
        // try centered in the span, then flush to either end of it
        const candidates = [center, a + foot.w / 2 + 0.04, b - foot.w / 2 - 0.04]
        for (const t of candidates) {
          if (t - foot.w / 2 < g.from + 0.04 || t + foot.w / 2 > g.to - 0.04) continue
          const x = g.axis === 'x' ? t : inset
          const z = g.axis === 'x' ? inset : t
          const rotated = Math.abs(Math.sin(g.rotY)) > 0.5
          const w = rotated ? foot.d : foot.w
          const d = rotated ? foot.w : foot.d
          const aabb = { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 }
          if (!fits(aabb, { height })) continue
          return { ...commit(Comp, props, x, z, g.rotY, foot), edge: e }
        }
      }
    }
    return null
  }

  function atPoint(Comp, props, footArgs, x, z, rotY, opts = {}) {
    const foot = Comp.foot(...(footArgs || []))
    const rotated = Math.abs(Math.sin(rotY)) > 0.5
    const w = rotated ? foot.d : foot.w
    const d = rotated ? foot.w : foot.d
    const aabb = { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 }
    if (!fits(aabb, opts) && !opts.force) return null
    return commit(Comp, props, x, z, rotY, foot, opts)
  }

  function inCorner(Comp, props, footArgs) {
    const foot = Comp.foot(...(footArgs || []))
    const { minX, maxX, minZ, maxZ } = room.bbox
    // Each corner carries the rotation that turns the piece's closed
    // +x/+z sides toward that corner's walls (matters for e.g. showers).
    const corners = [
      [minX + foot.w / 2 + 0.15, minZ + foot.d / 2 + 0.15, Math.PI],
      [maxX - foot.w / 2 - 0.15, minZ + foot.d / 2 + 0.15, Math.PI / 2],
      [minX + foot.w / 2 + 0.15, maxZ - foot.d / 2 - 0.15, -Math.PI / 2],
      [maxX - foot.w / 2 - 0.15, maxZ - foot.d / 2 - 0.15, 0],
    ].sort(() => rand() - 0.5)
    for (const [x, z, rotY] of corners) {
      const aabb = { minX: x - foot.w / 2, maxX: x + foot.w / 2, minZ: z - foot.d / 2, maxZ: z + foot.d / 2 }
      if (fits(aabb)) {
        return commit(Comp, props, x, z, foot.cornerOriented ? rotY : rand() * Math.PI * 2, foot)
      }
    }
    return null
  }

  return { againstEdge, atPoint, inCorner, items, rand }
}

// --- layouts per furniture set ------------------------------------------------

const LAYOUTS = {
  bedroom(p, room) {
    const long = room.bbox.maxX - room.bbox.minX > room.bbox.maxZ - room.bbox.minZ
    const bedW = room.area > 13 ? 1.7 : 1.5
    const bed = p.againstEdge(P.Bed, { w: bedW }, [bedW], long ? ['N', 'S'] : ['W', 'E'], { height: 1.1 })
    if (bed) {
      // nightstands flanking the headboard
      const g = edgeGeometry(room, bed.edge)
      const side = g.axis === 'x' ? 'x' : 'z'
      for (const k of [-1, 1]) {
        const nx = side === 'x' ? bed.x + k * (bedW / 2 + 0.35) : bed.x
        const nz = side === 'x' ? bed.z : bed.z + k * (bedW / 2 + 0.35)
        p.atPoint(P.Nightstand, {}, [], nx, nz, bed.rotY, { height: 0.75 })
      }
      // rug under the foot of the bed
      const fx = bed.x - Math.sin(bed.rotY) * 1.4
      const fz = bed.z - Math.cos(bed.rotY) * 1.4
      p.atPoint(P.Rug, {}, [], fx, fz, bed.rotY, { walkable: true })
    }
    p.againstEdge(P.Wardrobe, {}, [Math.min(2.2, room.area > 12 ? 1.8 : 1.2)], null, { height: 2.2 })
    if (room.area > 12) p.inCorner(P.Plant, {}, [])
  },

  living(p, room) {
    // try progressively narrower TV units until one fits a wall
    let tv = null
    for (const tw of [1.8, 1.5, 1.2]) {
      tv = p.againstEdge(P.TVUnit, { w: tw }, [tw], null, { height: 1.4 })
      if (tv) break
    }
    if (tv) {
      const dist = Math.min(3.1, Math.max(2.2, room.area / 8))
      // sofa sits in front of the TV: along the TV's facing direction (-z local),
      // nudged sideways (and shrunk) until it clears walls and other furniture
      const fx = -Math.sin(tv.rotY), fz = -Math.cos(tv.rotY)
      const lxAxis = Math.cos(tv.rotY), lzAxis = -Math.sin(tv.rotY)
      let sofa = null
      outer: for (const sw of [2.2, 1.8]) {
        for (const off of [0, -0.5, 0.5, -1.0, 1.0]) {
          sofa = p.atPoint(
            P.Sofa, { w: sw }, [sw],
            tv.x + fx * dist + lxAxis * off,
            tv.z + fz * dist + lzAxis * off,
            tv.rotY + Math.PI,
            { height: 1 }
          )
          if (sofa) break outer
        }
      }
      const mx = (tv.x + (sofa?.x ?? tv.x + fx * dist)) / 2
      const mz = (tv.z + (sofa?.z ?? tv.z + fz * dist)) / 2
      p.atPoint(P.Rug, { w: 2.8, d: 2 }, [2.8, 2], mx, mz, tv.rotY, { walkable: true })
      p.atPoint(P.CoffeeTable, {}, [], mx, mz, tv.rotY, { height: 0.45 })
      if (sofa) {
        const lx = sofa.x + Math.cos(sofa.rotY) * 1.5
        const lz = sofa.z - Math.sin(sofa.rotY) * 1.5
        p.atPoint(P.FloorLamp, {}, [], lx, lz, 0, { height: 1.7 })
      }
    } else {
      p.atPoint(P.Sofa, { w: 2.2 }, [2.2], room.center.x, room.center.z, 0, { height: 1 })
    }
    if (room.area > 15) p.againstEdge(P.Bookshelf, {}, [1.4], null, { height: 2.0 })
    p.inCorner(P.Plant, {}, [])
    if (room.area > 20) p.atPoint(P.DiningSet, { seats: 4 }, [4],
      room.center.x + (p.rand() - 0.5) * 2, room.center.z + (p.rand() - 0.5) * 2, 0, { height: 1 })
  },

  dining(p, room) {
    p.atPoint(P.DiningSet, { seats: 6 }, [6], room.center.x, room.center.z,
      room.bbox.maxX - room.bbox.minX > room.bbox.maxZ - room.bbox.minZ ? 0 : Math.PI / 2, { height: 1 })
    p.inCorner(P.Plant, {}, [])
  },

  kitchen(p, room) {
    const edgeLens = EDGES.map((e) => {
      const g = edgeGeometry(room, e)
      return { e, len: g.to - g.from }
    }).sort((a, b) => b.len - a.len)
    // try progressively shorter counter runs until one fits between openings
    const ideal = Math.min(3.4, Math.max(1.8, edgeLens[0].len - 1.2))
    let run = null
    let runW = ideal
    for (const w of [ideal, 2.8, 2.4, 1.8].filter((w, i, a) => w <= ideal && a.indexOf(w) === i)) {
      runW = w
      run = p.againstEdge(P.KitchenRun, { w }, [w], [edgeLens[0].e, edgeLens[1].e], { height: 2.3 })
      if (run) break
    }
    if (run) {
      const g = edgeGeometry(room, run.edge)
      for (const end of [1, -1]) {
        const off = (runW / 2 + 0.45) * end
        const fx = g.axis === 'x' ? run.x + off : run.x
        const fz = g.axis === 'x' ? run.z : run.z + off
        if (p.atPoint(P.Fridge, {}, [], fx, fz, run.rotY, { height: 1.9 })) break
      }
    }
    if (room.area > 11) {
      for (const off of [0.3, -0.4, -0.9, 0.9]) {
        if (p.atPoint(P.DiningSet, { seats: 4 }, [4], room.center.x, room.center.z + off, Math.PI / 2, { height: 1 })) break
      }
    }
  },

  bathroom(p, room) {
    p.againstEdge(P.Vanity, {}, [], null, { height: 1.7 })
    p.againstEdge(P.Toilet, {}, [], null, { height: 0.8 })
    if (room.area > 3.4) p.inCorner(P.Shower, {}, [])
  },

  office(p, room) {
    const count = Math.max(1, Math.min(12, Math.floor(room.area / 5.5)))
    const cols = Math.ceil(Math.sqrt(count))
    const rows = Math.ceil(count / cols)
    const spanX = cols * 1.9, spanZ = rows * 2.1
    let placedCount = 0
    for (let r = 0; r < rows && placedCount < count; r++) {
      for (let c = 0; c < cols && placedCount < count; c++) {
        const x = room.center.x + (c - (cols - 1) / 2) * (spanX / Math.max(1, cols))
        const z = room.center.z + (r - (rows - 1) / 2) * (spanZ / Math.max(1, rows))
        const desk = p.atPoint(P.Desk, {}, [], x, z, Math.PI, { height: 1.2 })
        if (desk) {
          placedCount++
          // chair tucked into the desk's front, seat facing the monitor
          p.atPoint(P.OfficeChair, {}, [], x, z + 0.62, 0, { height: 1.2, ignorePlaced: true })
        }
      }
    }
    if (room.area > 14) p.againstEdge(P.Bookshelf, {}, [1.4], null, { height: 2.0 })
    p.inCorner(P.Plant, {}, [])
  },

  meeting(p, room) {
    const long = room.bbox.maxX - room.bbox.minX > room.bbox.maxZ - room.bbox.minZ
    const roomLong = Math.max(room.bbox.maxX - room.bbox.minX, room.bbox.maxZ - room.bbox.minZ)
    const tw = Math.min(3.2, Math.max(2.0, roomLong - 2.2))
    const rotY = long ? 0 : Math.PI / 2
    const table = p.atPoint(P.MeetingTable, { w: tw }, [tw], room.center.x, room.center.z, rotY, { height: 1 })
    if (table) {
      const n = Math.floor(tw / 0.75)
      for (let i = 0; i < n; i++) {
        const t = (i - (n - 1) / 2) * 0.78
        for (const k of [1, -1]) {
          const ox = long ? t : k * 0.85
          const oz = long ? k * 0.85 : t
          p.atPoint(P.OfficeChair, {}, [], room.center.x + ox, room.center.z + oz,
            long ? (k > 0 ? 0 : Math.PI) : k > 0 ? Math.PI / 2 : -Math.PI / 2,
            { height: 1.2, ignorePlaced: true })
        }
      }
    }
    p.againstEdge(P.Whiteboard, {}, [1.8], null, { height: 2.0 })
    p.inCorner(P.Plant, {}, [])
  },

  reception(p, room) {
    // shrink the desk until it clears the room's doors/windows
    let desk = null
    for (const dw of [2.2, 1.8, 1.4, 1.0, 0.9, 0.8]) {
      desk = p.againstEdge(P.ReceptionDesk, { w: dw }, [dw], null, { height: 1.3 })
      if (desk) break
    }
    if (desk) {
      // receptionist's chair sits in front of the desk, facing back toward it
      const fx = -Math.sin(desk.rotY), fz = -Math.cos(desk.rotY)
      p.atPoint(P.OfficeChair, {}, [], desk.x + fx * 0.55, desk.z + fz * 0.55, desk.rotY + Math.PI,
        { height: 1.2, ignorePlaced: true })
    } else {
      p.atPoint(P.OfficeChair, {}, [],
        room.center.x + (p.rand() - 0.5), room.center.z + (p.rand() - 0.5), p.rand() * 6.28, { height: 1.2 })
    }
    for (let i = 0; i < 2; i++) p.againstEdge(P.LoungeChair, {}, [], null, { height: 1 })
    p.inCorner(P.Plant, {}, [])
  },

  hall(p, room) {
    if (room.area > 4.5) p.inCorner(P.Plant, {}, [])
  },

  balcony(p, room) {
    p.atPoint(P.BalconySet, {}, [], room.center.x, room.center.z, 0, { height: 1 })
  },

  none() {},
}

export default function Furniture({ plan }) {
  const allItems = useMemo(() => {
    const out = []
    for (const room of plan.rooms) {
      const setKey = roomConfig(room.type).furniture
      const layout = LAYOUTS[setKey] || LAYOUTS.none
      const info = analyzeRoom(plan, room)
      const placer = makePlacer(plan, room, info, rng(room.id + plan.name))
      layout(placer, room)
      // walkability guarantee: every door of the room must stay reachable by
      // the player capsule — evict furniture that pinches the circulation
      repairCirculation(plan, room, placer.items)
      out.push(...placer.items)
    }
    if (import.meta.env.DEV) window.__strideFurniture = out
    return out
  }, [plan])

  useEffect(() => {
    const cleanups = allItems
      .filter((it) => !it.walkable)
      .map((it) => registerCollider(it.aabb))
    return () => cleanups.forEach((fn) => fn())
  }, [allItems])

  return (
    <group>
      {allItems.map((it, i) => (
        <group key={i} position={[it.x, 0, it.z]} rotation={[0, it.rotY, 0]}>
          <it.Comp {...it.props} />
        </group>
      ))}
    </group>
  )
}
