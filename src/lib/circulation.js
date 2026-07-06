// Furniture circulation guarantee. Placement rules (inside room, no overlap,
// clear of door swings) can still produce layouts that pinch the walkable
// space — a table 0.4m from a counter reads fine to an AABB check but the
// player capsule (r=0.28) cannot pass. After a room is furnished, simulate
// that capsule on the plan grid and require every door of the room to stay
// mutually reachable; if not, evict furniture until it is.

const PLAYER_R = 0.28 // keep in sync with Player.jsx / planProcess.js

// All non-window openings that open into this room, as seed points nudged
// inside it.
function roomGates(plan, room) {
  const gates = []
  for (const wall of plan.walls) {
    const len = Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z)
    if (!len) continue
    const ux = (wall.end.x - wall.start.x) / len
    const uz = (wall.end.z - wall.start.z) / len
    for (const o of wall.openings) {
      if (o.type === 'window') continue
      const cx = wall.start.x + ux * o.position
      const cz = wall.start.z + uz * o.position
      for (const sign of [1, -1]) {
        let found = null
        for (const off of [wall.thickness / 2 + 0.35, wall.thickness / 2 + 0.55]) {
          const x = cx - uz * off * sign
          const z = cz + ux * off * sign
          if (cellRoom(plan.grid, x, z) === room.gridIndex) { found = { x, z }; break }
        }
        if (found) { gates.push(found); break }
      }
    }
  }
  return gates
}

function cellRoom(grid, x, z) {
  const cx = Math.floor((x - grid.originX) / grid.cell)
  const cy = Math.floor((z - grid.originZ) / grid.cell)
  if (cx < 0 || cy < 0 || cx >= grid.w || cy >= grid.h) return -2
  return grid.cells[cy * grid.w + cx]
}

// Walkable mask for one room: cells of the room whose surrounding disc of
// player radius is still room cells (wall erosion), minus cells inside any
// solid furniture AABB inflated by the player radius.
function buildWalkable(plan, room, items) {
  const g = plan.grid
  const rCells = Math.ceil(PLAYER_R / g.cell)
  const offsets = []
  for (let oy = -rCells; oy <= rCells; oy++) {
    for (let ox = -rCells; ox <= rCells; ox++) {
      if ((ox * ox + oy * oy) * g.cell * g.cell <= PLAYER_R * PLAYER_R + 1e-9) offsets.push([ox, oy])
    }
  }
  const walkable = new Uint8Array(g.w * g.h)
  for (let cy = 0; cy < g.h; cy++) {
    for (let cx = 0; cx < g.w; cx++) {
      if (g.cells[cy * g.w + cx] !== room.gridIndex) continue
      let ok = true
      for (const [ox, oy] of offsets) {
        const nx = cx + ox
        const ny = cy + oy
        if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h || g.cells[ny * g.w + nx] !== room.gridIndex) { ok = false; break }
      }
      if (!ok) continue
      const wx = g.originX + (cx + 0.5) * g.cell
      const wz = g.originZ + (cy + 0.5) * g.cell
      let blocked = false
      for (const it of items) {
        if (it.walkable) continue
        const a = it.aabb
        if (wx > a.minX - PLAYER_R && wx < a.maxX + PLAYER_R && wz > a.minZ - PLAYER_R && wz < a.maxZ + PLAYER_R) { blocked = true; break }
      }
      if (!blocked) walkable[cy * g.w + cx] = 1
    }
  }
  return walkable
}

// score = (gates in the largest gate-connected component) * 1e6 + its cell
// count — higher is better circulation.
function circulationScore(plan, room, gates, items) {
  const g = plan.grid
  const walkable = buildWalkable(plan, room, items)
  // seed each gate at its nearest walkable cell (gates sit near walls, which
  // erosion shaves — search a small neighborhood)
  const seeds = []
  for (const gate of gates) {
    const cx = Math.floor((gate.x - g.originX) / g.cell)
    const cy = Math.floor((gate.z - g.originZ) / g.cell)
    let best = null
    const R = 7 // cells (~0.7m)
    for (let oy = -R; oy <= R; oy++) {
      for (let ox = -R; ox <= R; ox++) {
        const nx = cx + ox
        const ny = cy + oy
        if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h || !walkable[ny * g.w + nx]) continue
        const d = ox * ox + oy * oy
        if (!best || d < best.d) best = { idx: ny * g.w + nx, d }
      }
    }
    seeds.push(best ? best.idx : -1)
  }

  // flood from each seed; union components; count gates + cells per component
  const comp = new Int32Array(g.w * g.h).fill(-1)
  const compCells = []
  const floodFrom = (start, id) => {
    let count = 0
    const stack = [start]
    comp[start] = id
    while (stack.length) {
      const idx = stack.pop()
      count++
      const x = idx % g.w
      const y = (idx / g.w) | 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue
        const nidx = ny * g.w + nx
        if (walkable[nidx] && comp[nidx] === -1) { comp[nidx] = id; stack.push(nidx) }
      }
    }
    return count
  }
  const gateComp = []
  for (const s of seeds) {
    if (s < 0) { gateComp.push(-1); continue }
    if (comp[s] === -1) compCells.push(floodFrom(s, compCells.length))
    gateComp.push(comp[s])
  }
  let bestScore = 0
  const total = walkable.reduce((a, b) => a + b, 0)
  for (let id = 0; id < compCells.length; id++) {
    const gatesHere = gateComp.filter((c) => c === id).length
    const score = gatesHere * 1e6 + compCells[id]
    if (score > bestScore) bestScore = score
  }
  // a room should not just connect its doors — most of it should stay usable
  return { score: bestScore, gatesTotal: gates.length, gatesConnected: Math.floor(bestScore / 1e6), mainCells: bestScore % 1e6, totalWalkable: total }
}

// Evict furniture until every door of the room is mutually reachable and the
// main walkable region covers most of the room. Mutates `items` (the same
// array the renderer consumes). Returns the number of removed pieces.
export function repairCirculation(plan, room, items) {
  const gates = roomGates(plan, room)
  if (!gates.length) return 0

  const healthy = (s) =>
    s.gatesConnected === s.gatesTotal &&
    (s.totalWalkable === 0 || s.mainCells >= s.totalWalkable * 0.65)

  let state = circulationScore(plan, room, gates, items)
  if (healthy(state)) return 0

  let removed = 0
  let guard = items.length + 2
  while (!healthy(state) && guard-- > 0) {
    // try candidates newest-first (decor before anchor pieces); keep the
    // first removal that strictly improves circulation
    let acted = false
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].walkable) continue
      const candidate = items[i]
      items.splice(i, 1)
      const next = circulationScore(plan, room, gates, items)
      if (next.score > state.score) {
        state = next
        removed++
        acted = true
        break
      }
      items.splice(i, 0, candidate) // restore, try the next one
    }
    if (!acted) {
      // no single removal helps (compound blockage) — force-drop the newest
      // solid piece and keep going
      const i = items.map((it) => !it.walkable).lastIndexOf(true)
      if (i < 0) break
      items.splice(i, 1)
      removed++
      state = circulationScore(plan, room, gates, items)
    }
  }
  return removed
}
