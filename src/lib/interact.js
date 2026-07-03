// Shared registries the Player consults every frame:
//  - interactables: meshes the crosshair can target (doors, switches)
//  - colliders: static furniture AABBs
//  - doorSegments: dynamic wall segments for closed door leaves
// Scene components register on mount and clean up on unmount.

export const interactables = new Map() // id -> { object, label, action }
let nextId = 1

export function registerInteractable({ object, label, action }) {
  const id = nextId++
  object.traverse((o) => (o.userData.interactId = id))
  object.userData.interactId = id
  interactables.set(id, { object, label, action })
  return () => interactables.delete(id)
}

export const colliders = [] // { minX, maxX, minZ, maxZ }
export function registerCollider(box) {
  colliders.push(box)
  return () => {
    const i = colliders.indexOf(box)
    if (i >= 0) colliders.splice(i, 1)
  }
}

export const doorSegments = new Map() // doorId -> { ax, az, bx, bz, r }
export function setDoorSegment(doorId, seg) {
  if (seg) doorSegments.set(doorId, seg)
  else doorSegments.delete(doorId)
}

export function clearAllRegistries() {
  interactables.clear()
  colliders.length = 0
  doorSegments.clear()
}
