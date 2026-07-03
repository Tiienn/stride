// Per-room lighting: a ceiling fixture whose emissive glow and point light
// toggle together, plus a clickable wall switch placed beside the room's door.
import * as THREE from 'three'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { MAT, plainMaterial } from '../lib/textures.js'
import { roomConfig } from '../lib/roomTypes.js'
import { registerInteractable } from '../lib/interact.js'
import { roomAt } from '../lib/planProcess.js'
import { useStride } from '../store.js'
import { audio } from '../lib/audio.js'

const CEIL = 2.7

// Large rooms get a grid of fixtures, the way real ceilings do.
function fixturePositions(room) {
  const w = room.bbox.maxX - room.bbox.minX
  const d = room.bbox.maxZ - room.bbox.minZ
  const n = Math.max(1, Math.min(4, Math.round(room.area / 18)))
  if (n === 1) return [{ x: room.center.x, z: room.center.z }]
  const cols = w >= d ? Math.ceil(Math.sqrt(n * (w / d))) : 1
  const realCols = Math.max(1, Math.min(n, cols))
  const rows = Math.ceil(n / realCols)
  const out = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < realCols && out.length < n; c++) {
      out.push({
        x: room.bbox.minX + ((c + 0.5) / realCols) * w,
        z: room.bbox.minZ + ((r + 0.5) / rows) * d,
      })
    }
  }
  return out
}

function Fixture({ room, on }) {
  const cfg = roomConfig(room.type)
  const positions = useMemo(() => fixturePositions(room), [room])
  const style = ['office', 'meeting', 'reception'].includes(room.type)
    ? 'panel'
    : ['living', 'dining'].includes(room.type) && positions.length === 1
      ? 'pendant'
      : 'dome'

  const emissiveMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#fefcf6',
        emissive: new THREE.Color(cfg.lightColor),
        emissiveIntensity: 0,
        roughness: 0.4,
      }),
    [cfg.lightColor]
  )
  useEffect(() => {
    emissiveMat.emissiveIntensity = on ? 3.2 : 0
    emissiveMat.color.set(on ? '#fefcf6' : '#d8d6d0')
  }, [on, emissiveMat])

  const total = on ? Math.min(70, 9 + room.area * 1.0) : 0
  const per = total / positions.length
  const cellRadius = Math.max(
    (room.bbox.maxX - room.bbox.minX) / (positions.length > 1 ? 2.6 : 2),
    (room.bbox.maxZ - room.bbox.minZ) / (positions.length > 1 ? 2.6 : 2)
  )
  const coneAngle = Math.min(1.25, Math.atan2(cellRadius + 0.8, 2.1))

  return (
    <group>
      {positions.map((p, i) => (
        <FixtureUnit
          key={i}
          x={p.x}
          z={p.z}
          style={style}
          emissiveMat={emissiveMat}
          color={cfg.lightColor}
          spot={per * 0.72}
          fill={per * 0.24}
          coneAngle={coneAngle}
        />
      ))}
    </group>
  )
}

function FixtureUnit({ x, z, style, emissiveMat, color, spot, fill, coneAngle }) {
  const lightRef = useRef()
  const targetRef = useRef()
  useLayoutEffect(() => {
    if (lightRef.current && targetRef.current) lightRef.current.target = targetRef.current
  }, [])

  return (
    <group position={[x, 0, z]}>
      {style === 'pendant' && (
        <>
          <mesh position={[0, CEIL - 0.26, 0]} material={MAT.black} castShadow>
            <cylinderGeometry args={[0.008, 0.008, 0.52, 6]} />
          </mesh>
          <mesh position={[0, CEIL - 0.58, 0]} material={MAT.black} castShadow>
            <cylinderGeometry args={[0.06, 0.21, 0.16, 24, 1, true]} />
          </mesh>
          <mesh position={[0, CEIL - 0.63, 0]} material={emissiveMat}>
            <sphereGeometry args={[0.075, 16, 12]} />
          </mesh>
        </>
      )}
      {style === 'dome' && (
        <>
          <mesh position={[0, CEIL - 0.02, 0]} material={MAT.metal}>
            <cylinderGeometry args={[0.17, 0.17, 0.035, 24]} />
          </mesh>
          <mesh position={[0, CEIL - 0.05, 0]} material={emissiveMat}>
            <sphereGeometry args={[0.14, 20, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2]} />
          </mesh>
        </>
      )}
      {style === 'panel' && (
        <>
          <mesh position={[0, CEIL - 0.03, 0]} material={MAT.metal}>
            <boxGeometry args={[1.24, 0.055, 0.34]} />
          </mesh>
          <mesh position={[0, CEIL - 0.06, 0]} material={emissiveMat}>
            <boxGeometry args={[1.16, 0.012, 0.26]} />
          </mesh>
        </>
      )}
      <spotLight
        ref={lightRef}
        position={[0, style === 'pendant' ? CEIL - 0.72 : CEIL - 0.3, 0]}
        intensity={spot}
        color={color}
        angle={coneAngle}
        penumbra={0.9}
        decay={2}
        distance={0}
      />
      {/* faked bounce light: lifts walls + ceiling the way real GI would */}
      {fill > 0 && (
        <pointLight position={[0, 1.85, 0]} intensity={fill} color={color} decay={2} distance={0} />
      )}
      <object3D ref={targetRef} position={[0, 0, 0]} />
    </group>
  )
}

const switchPlate = plainMaterial({ color: '#eeeae1', roughness: 0.35 })
const switchRocker = plainMaterial({ color: '#ddd8cc', roughness: 0.3 })
const hitboxMat = new THREE.MeshBasicMaterial({
  transparent: true,
  opacity: 0,
  depthWrite: false,
})

function Switch({ placement, room }) {
  const group = useRef()
  const toggle = useStride((s) => s.toggleRoomLight)
  const on = useStride((s) => !!s.roomLights[room.id])

  // Real switches glow so you can find them — ours too. Amber when the room
  // is lit, a faint ember when it's dark (that's when you need it most).
  const dotMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#e8b74a',
        emissive: new THREE.Color('#e8963a'),
        emissiveIntensity: 1.4,
        roughness: 0.4,
      }),
    []
  )
  useEffect(() => {
    dotMat.emissiveIntensity = on ? 1.6 : 0.5
  }, [on, dotMat])

  useEffect(() => {
    if (!group.current) return
    return registerInteractable({
      object: group.current,
      label: () => {
        const isOn = useStride.getState().roomLights[room.id]
        return `${isOn ? 'Lights off' : 'Lights on'} · ${room.name}`
      },
      action: () => {
        const wasOn = useStride.getState().roomLights[room.id]
        toggle(room.id)
        audio.switchClick(!wasOn)
      },
    })
  }, [room.id, room.name, toggle])

  return (
    <group
      ref={group}
      position={[placement.x, 1.15, placement.z]}
      rotation={[0, placement.rotY, 0]}
    >
      <mesh material={switchPlate} castShadow>
        <boxGeometry args={[0.085, 0.13, 0.014]} />
      </mesh>
      <mesh position={[0, 0, 0.011]} material={switchRocker}>
        <boxGeometry args={[0.045, 0.075, 0.012]} />
      </mesh>
      {/* indicator dot */}
      <mesh position={[0, -0.048, 0.016]} material={dotMat}>
        <sphereGeometry args={[0.007, 8, 6]} />
      </mesh>
      {/* generous invisible hitbox — aiming at an 8 cm plate is fiddly */}
      <mesh material={hitboxMat}>
        <boxGeometry args={[0.34, 0.42, 0.12]} />
      </mesh>
    </group>
  )
}

// Find a wall spot beside a door, on this room's side of the wall.
function switchPlacements(plan) {
  const placements = new Map()
  for (const wall of plan.walls) {
    const len = Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z)
    const angle = Math.atan2(wall.end.z - wall.start.z, wall.end.x - wall.start.x)
    const ux = (wall.end.x - wall.start.x) / len
    const uz = (wall.end.z - wall.start.z) / len
    const nx = -uz, nz = ux
    for (const o of wall.openings) {
      if (o.type === 'window') continue
      for (const side of [1, -1]) {
        const off = wall.thickness / 2 + 0.03
        for (const along of [o.position + o.width / 2 + 0.22, o.position - o.width / 2 - 0.22]) {
          if (along < 0.1 || along > len - 0.1) continue
          const px = wall.start.x + ux * along + nx * off * side
          const pz = wall.start.z + uz * along + nz * off * side
          // probe a little further into the space to identify the room
          const probe = roomAt(plan, px + nx * 0.25 * side, pz + nz * 0.25 * side)
          if (probe && !placements.has(probe.id)) {
            placements.set(probe.id, {
              x: px,
              z: pz,
              rotY: -angle + (side > 0 ? 0 : Math.PI),
            })
          }
        }
      }
    }
  }
  return placements
}

export default function RoomLights({ plan }) {
  const roomLights = useStride((s) => s.roomLights)
  const placements = useMemo(() => switchPlacements(plan), [plan])
  return (
    <group>
      {plan.rooms.map((room) => (
        <group key={room.id}>
          <Fixture room={room} on={!!roomLights[room.id]} />
          {placements.has(room.id) && <Switch placement={placements.get(room.id)} room={room} />}
        </group>
      ))}
    </group>
  )
}
