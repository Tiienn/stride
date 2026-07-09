// Interactive hinged doors. Each leaf animates open/closed, plays hinge/latch
// sounds, and registers/withdraws a collision segment so you can't ghost
// through a closed door.
import * as THREE from 'three'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { MAT } from '../lib/textures.js'
import { registerInteractable, setDoorSegment } from '../lib/interact.js'
import { audio } from '../lib/audio.js'

const OPEN_ANGLE = THREE.MathUtils.degToRad(104)

function collectDoors(plan) {
  const doors = []
  for (const wall of plan.walls) {
    const len = Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z)
    const angle = Math.atan2(wall.end.z - wall.start.z, wall.end.x - wall.start.x)
    const ux = (wall.end.x - wall.start.x) / len
    const uz = (wall.end.z - wall.start.z) / len
    for (const o of wall.openings) {
      if (o.type !== 'door' && o.type !== 'entrance') continue
      // Hinge at whichever OPENING end the plan's arc indicated (default 'start').
      const hingeAtEnd = o.hingeEnd === 'end'
      const hingeT = hingeAtEnd ? o.position + o.width / 2 : o.position - o.width / 2
      const farT = hingeAtEnd ? o.position - o.width / 2 : o.position + o.width / 2
      // Leaf points from the hinge toward the far end: +wall dir for a start
      // hinge, −wall dir (angle+π) for an end hinge.
      const swingSide = o.swingSide === -1 ? -1 : 1
      doors.push({
        id: o.id,
        entrance: o.type === 'entrance',
        width: o.width,
        height: o.height,
        thickness: wall.thickness,
        hinge: { x: wall.start.x + ux * hingeT, z: wall.start.z + uz * hingeT },
        end: {
          x: wall.start.x + ux * farT,
          z: wall.start.z + uz * farT,
        },
        angle: angle + (hingeAtEnd ? Math.PI : 0),
        // pivot multiplier: −swingSide for a start hinge, +swingSide for an end
        // hinge (the leaf's local frame flips with the extra π). Default door
        // (start hinge, swingSide +1) → −1, i.e. the legacy −OPEN_ANGLE swing.
        swing: swingSide * (hingeAtEnd ? 1 : -1),
      })
    }
  }
  return doors
}

function Door({ door }) {
  const [open, setOpen] = useState(false)
  const pivot = useRef()
  const group = useRef()
  const current = useRef(0)

  const leafW = door.width - 0.06
  const leafH = door.height - 0.04
  const mat = door.entrance ? MAT.doorDark : MAT.doorLeaf

  // Closed-door collision segment
  useEffect(() => {
    if (!open) {
      setDoorSegment(door.id, {
        ax: door.hinge.x, az: door.hinge.z,
        bx: door.end.x, bz: door.end.z,
        r: 0.05,
      })
    } else {
      setDoorSegment(door.id, null)
    }
    return () => setDoorSegment(door.id, null)
  }, [open, door])

  useEffect(() => {
    if (!group.current) return
    return registerInteractable({
      object: group.current,
      label: () => (open ? 'Close door' : 'Open door'),
      action: () => {
        setOpen((v) => {
          if (v) audio.doorClose()
          else audio.doorOpen()
          return !v
        })
      },
    })
  }, [open])

  useFrame((_, dt) => {
    const target = open ? door.swing * OPEN_ANGLE : 0
    const next = THREE.MathUtils.damp(current.current, target, 6, dt)
    current.current = next
    if (pivot.current) pivot.current.rotation.y = next
  })

  return (
    <group
      ref={group}
      position={[door.hinge.x, 0, door.hinge.z]}
      rotation={[0, -door.angle, 0]}
    >
      <group ref={pivot}>
        {/* leaf */}
        <mesh position={[leafW / 2 + 0.03, leafH / 2, 0]} material={mat} castShadow receiveShadow>
          <boxGeometry args={[leafW, leafH, 0.042]} />
        </mesh>
        {/* inset panels */}
        {[0.32, 0.72].map((f) => (
          <mesh
            key={f}
            position={[leafW / 2 + 0.03, leafH * f, 0]}
            material={door.entrance ? MAT.black : MAT.trim}
          >
            <boxGeometry args={[leafW * 0.72, leafH * 0.3, 0.05]} />
          </mesh>
        ))}
        {/* lever handles, both faces */}
        {[0.032, -0.032].map((zo, i) => (
          <group key={i} position={[leafW - 0.09, 1.02, zo]}>
            <mesh material={MAT.handle} castShadow>
              <cylinderGeometry args={[0.012, 0.012, 0.05, 12]} />
            </mesh>
            <mesh
              material={MAT.handle}
              position={[-0.055, 0, zo > 0 ? 0.022 : -0.022]}
              rotation={[0, 0, Math.PI / 2]}
              castShadow
            >
              <capsuleGeometry args={[0.011, 0.1, 4, 10]} />
            </mesh>
          </group>
        ))}
      </group>
    </group>
  )
}

export default function Doors({ plan }) {
  const doors = useMemo(() => collectDoors(plan), [plan])
  return (
    <group>
      {doors.map((d) => (
        <Door key={d.id} door={d} />
      ))}
    </group>
  )
}
