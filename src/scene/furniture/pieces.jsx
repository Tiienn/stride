// Procedural furniture. Each piece is built from primitives with PBR
// materials and careful proportions; each exports its footprint so the
// placer can reason about space.
// ORIENTATION CONVENTION: origin = center of footprint on the floor.
// Local +z is the BACK (the side the placer puts against a wall).
// Local -z is the FRONT (faces into the room).
import { surfaceMaterial, MAT, plainMaterial } from '../../lib/textures.js'

const wood = () => surfaceMaterial('woodFurniture', { repeat: 1.4 })
const fabric = () => surfaceMaterial('fabric', { repeat: 1.6 })
const mattress = plainMaterial({ color: '#f5f2ec', roughness: 0.9 })
const bedding = plainMaterial({ color: '#c9d2dd', roughness: 0.95 })
const pillow = plainMaterial({ color: '#ffffff', roughness: 0.95 })
const legMat = plainMaterial({ color: '#2c2c30', roughness: 0.5, metalness: 0.4 })
const counterTop = plainMaterial({ color: '#e8e6e0', roughness: 0.25 })
const cabinet = plainMaterial({ color: '#59605e', roughness: 0.55 })
const steel = plainMaterial({ color: '#c4c8cc', roughness: 0.3, metalness: 0.9 })
const chairShell = plainMaterial({ color: '#3f4650', roughness: 0.6 })
const deskTop = plainMaterial({ color: '#f0ece2', roughness: 0.4 })
const cushionA = plainMaterial({ color: '#c9b18c', roughness: 0.92 })
const cushionB = plainMaterial({ color: '#7c8a99', roughness: 0.92 })

const B = ({ s, p = [0, 0, 0], r, m, cast = true }) => (
  <mesh castShadow={cast} receiveShadow position={p} rotation={r} material={m}>
    <boxGeometry args={s} />
  </mesh>
)
const C = ({ rt, rb, h, p = [0, 0, 0], m, seg = 16, cast = true }) => (
  <mesh castShadow={cast} receiveShadow position={p} material={m}>
    <cylinderGeometry args={[rt, rb, h, seg]} />
  </mesh>
)
// squashed sphere — reads as a puffy cushion from any angle, unlike a thin
// box which flattens to a card-like silhouette when viewed edge-on
const Cushion = ({ s, p = [0, 0, 0], r, m }) => (
  <mesh castShadow receiveShadow position={p} rotation={r} scale={s} material={m}>
    <sphereGeometry args={[1, 12, 8]} />
  </mesh>
)

export function Bed({ w = 1.7, l = 2.1 }) {
  // headboard at +z (against the wall), foot of the bed toward the room
  return (
    <group>
      <B s={[w, 0.22, l]} p={[0, 0.2, 0]} m={wood()} />
      <B s={[w - 0.06, 0.2, l - 0.1]} p={[0, 0.4, -0.02]} m={mattress} />
      <B s={[w - 0.04, 0.14, l * 0.62]} p={[0, 0.45, -l * 0.16]} m={bedding} />
      <B s={[w, 0.85, 0.07]} p={[0, 0.62, l / 2 - 0.035]} m={wood()} />
      <B s={[w * 0.38, 0.12, 0.5]} p={[-w * 0.24, 0.55, l / 2 - 0.42]} r={[-0.12, 0, 0.04]} m={pillow} />
      <B s={[w * 0.38, 0.12, 0.5]} p={[w * 0.24, 0.55, l / 2 - 0.42]} r={[-0.12, 0, -0.04]} m={pillow} />
    </group>
  )
}
Bed.foot = (w = 1.7, l = 2.1) => ({ w, d: l })

export function Nightstand() {
  return (
    <group>
      <B s={[0.48, 0.42, 0.4]} p={[0, 0.31, 0]} m={wood()} />
      <B s={[0.4, 0.06, 0.34]} p={[0, 0.35, -0.04]} m={MAT.trim} />
      {legFrame(0.48, 0.4, 0.1)}
      <C rt={0.09} rb={0.12} h={0.13} p={[0, 0.62, 0]} m={MAT.trim} />
      <C rt={0.012} rb={0.012} h={0.12} p={[0, 0.52, 0]} m={MAT.handle} />
    </group>
  )
}
Nightstand.foot = () => ({ w: 0.48, d: 0.4 })

export function Wardrobe({ w = 1.8 }) {
  return (
    <group>
      <B s={[w, 2.15, 0.6]} p={[0, 1.075, 0]} m={wood()} />
      <B s={[0.016, 1.7, 0.02]} p={[-0.04, 1.0, -0.31]} m={MAT.handle} />
      <B s={[0.016, 1.7, 0.02]} p={[0.04, 1.0, -0.31]} m={MAT.handle} />
    </group>
  )
}
Wardrobe.foot = (w = 1.8) => ({ w, d: 0.6 })

export function Sofa({ w = 2.2 }) {
  return (
    <group>
      <B s={[w, 0.32, 0.95]} p={[0, 0.22, 0]} m={fabric()} />
      <B s={[w, 0.45, 0.24]} p={[0, 0.6, 0.36]} m={fabric()} />
      <B s={[0.22, 0.32, 0.95]} p={[-w / 2 + 0.11, 0.52, 0]} m={fabric()} />
      <B s={[0.22, 0.32, 0.95]} p={[w / 2 - 0.11, 0.52, 0]} m={fabric()} />
      {[-1, 1].map((k) => (
        <B key={k} s={[w / 2 - 0.26, 0.14, 0.8]} p={[k * (w / 4 - 0.06), 0.45, -0.05]} m={fabric()} />
      ))}
      {/* two small throw cushions leaning into the seat/back corner */}
      <Cushion s={[0.19, 0.16, 0.19]} p={[-w / 4, 0.55, 0.12]} r={[0.5, 0.3, 0.1]} m={cushionA} />
      <Cushion s={[0.17, 0.15, 0.17]} p={[w / 4 - 0.1, 0.52, 0.1]} r={[0.45, -0.2, -0.08]} m={cushionB} />
      {legFrame(w - 0.1, 0.85, 0.09)}
    </group>
  )
}
Sofa.foot = (w = 2.2) => ({ w, d: 0.95 })

export function LoungeChair() {
  return (
    <group>
      <B s={[0.78, 0.3, 0.8]} p={[0, 0.22, 0]} m={fabric()} />
      <B s={[0.78, 0.5, 0.2]} p={[0, 0.55, 0.3]} m={fabric()} />
      {legFrame(0.7, 0.7, 0.09)}
    </group>
  )
}
LoungeChair.foot = () => ({ w: 0.78, d: 0.8 })

export function CoffeeTable() {
  return (
    <group>
      <B s={[1.1, 0.04, 0.6]} p={[0, 0.4, 0]} m={wood()} />
      <B s={[0.9, 0.03, 0.45]} p={[0, 0.18, 0]} m={wood()} />
      {legFrame(1.02, 0.54, 0.4)}
    </group>
  )
}
CoffeeTable.foot = () => ({ w: 1.1, d: 0.6 })

export function TVUnit({ w = 1.8 }) {
  return (
    <group>
      <B s={[w, 0.42, 0.42]} p={[0, 0.24, 0]} m={wood()} />
      {/* TV */}
      <B s={[w * 0.72, 0.74, 0.03]} p={[0, 0.95, 0.02]} m={MAT.screen} />
      <B s={[w * 0.74, 0.76, 0.015]} p={[0, 0.95, 0.035]} m={MAT.black} />
      <B s={[0.3, 0.06, 0.2]} p={[0, 0.48, 0]} m={MAT.black} />
    </group>
  )
}
TVUnit.foot = (w = 1.8) => ({ w, d: 0.5 })

export function Rug({ w = 2.6, d = 1.9 }) {
  return (
    <mesh receiveShadow position={[0, 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[w, d]} />
      <meshStandardMaterial color="#a5977f" roughness={1} />
    </mesh>
  )
}
Rug.foot = (w = 2.6, d = 1.9) => ({ w, d, walkable: true })

export function Plant() {
  return (
    <group>
      <C rt={0.16} rb={0.12} h={0.34} p={[0, 0.17, 0]} m={MAT.plantPot} />
      <C rt={0.02} rb={0.03} h={0.5} p={[0, 0.55, 0]} m={MAT.treeTrunk} seg={8} />
      {[
        [0.16, 0.95, 0.1, 0.24], [-0.18, 1.0, -0.05, 0.28], [0.02, 1.15, 0.14, 0.3],
        [-0.05, 0.85, -0.18, 0.22],
      ].map(([x, y, z, r], i) => (
        <mesh key={i} castShadow position={[x, y, z]} material={i % 2 ? MAT.foliage : MAT.plantGreen}>
          <sphereGeometry args={[r, 10, 8]} />
        </mesh>
      ))}
    </group>
  )
}
Plant.foot = () => ({ w: 0.55, d: 0.55 })

export function DiningSet({ seats = 4 }) {
  const chairs = []
  const perSide = Math.ceil(seats / 2)
  for (let i = 0; i < perSide; i++) {
    const x = (i - (perSide - 1) / 2) * 0.65
    // chair backs away from the table, seats facing it
    chairs.push([x, -0.75, Math.PI], [x, 0.75, 0])
  }
  return (
    <group>
      <B s={[perSide * 0.75 + 0.3, 0.045, 1.0]} p={[0, 0.74, 0]} m={wood()} />
      {legFrame(perSide * 0.75 + 0.1, 0.9, 0.72)}
      {chairs.slice(0, seats).map(([x, z, ry], i) => (
        <group key={i} position={[x, 0, z]} rotation={[0, ry, 0]}>
          <Chair />
        </group>
      ))}
    </group>
  )
}
DiningSet.foot = (seats = 4) => ({ w: Math.ceil(seats / 2) * 0.75 + 0.5, d: 2.6 })

export function Chair() {
  return (
    <group>
      <B s={[0.44, 0.04, 0.44]} p={[0, 0.46, 0]} m={wood()} />
      <B s={[0.44, 0.5, 0.04]} p={[0, 0.73, 0.2]} m={wood()} />
      {legFrame(0.4, 0.4, 0.44)}
    </group>
  )
}

export function KitchenRun({ w = 3 }) {
  const units = Math.floor(w / 0.6)
  return (
    <group>
      <B s={[w, 0.86, 0.62]} p={[0, 0.44, 0]} m={cabinet} />
      <B s={[w + 0.03, 0.04, 0.65]} p={[0, 0.89, 0]} m={counterTop} />
      {/* sink + tap (tap against the wall side) */}
      <B s={[0.5, 0.02, 0.4]} p={[-w / 4, 0.905, 0]} m={steel} />
      <group position={[-w / 4, 0.91, 0.22]}>
        <C rt={0.015} rb={0.015} h={0.24} p={[0, 0.12, 0]} m={steel} seg={10} />
        <B s={[0.03, 0.03, 0.18]} p={[0, 0.24, -0.08]} m={steel} />
      </group>
      {/* hob */}
      <B s={[0.55, 0.015, 0.5]} p={[w / 4, 0.906, 0]} m={MAT.black} />
      {/* upper cabinets hug the wall */}
      <B s={[w, 0.7, 0.35]} p={[0, 1.95, 0.13]} m={cabinet} />
      {/* door handles face the room */}
      {Array.from({ length: units }, (_, i) => (
        <B key={i} s={[0.14, 0.02, 0.02]} p={[(i - (units - 1) / 2) * 0.6, 0.78, -0.32]} m={MAT.handle} />
      ))}
    </group>
  )
}
KitchenRun.foot = (w = 3) => ({ w, d: 0.66 })

export function Fridge() {
  return (
    <group>
      <B s={[0.7, 1.85, 0.68]} p={[0, 0.925, 0]} m={steel} />
      <B s={[0.03, 0.5, 0.03]} p={[-0.28, 1.2, -0.35]} m={MAT.handle} />
    </group>
  )
}
Fridge.foot = () => ({ w: 0.72, d: 0.7 })

export function Toilet() {
  // cistern at +z against the wall, bowl toward the room
  return (
    <group>
      <B s={[0.4, 0.75, 0.2]} p={[0, 0.45, 0.19]} m={MAT.ceramic} />
      <C rt={0.19} rb={0.15} h={0.36} p={[0, 0.22, -0.06]} m={MAT.ceramic} seg={18} />
      <C rt={0.21} rb={0.21} h={0.04} p={[0, 0.42, -0.06]} m={MAT.ceramic} seg={18} />
    </group>
  )
}
Toilet.foot = () => ({ w: 0.44, d: 0.68 })

export function Vanity() {
  // tap + mirror on the wall side (+z)
  return (
    <group>
      <B s={[0.7, 0.5, 0.48]} p={[0, 0.45, 0]} m={wood()} />
      <B s={[0.74, 0.06, 0.52]} p={[0, 0.73, 0]} m={MAT.ceramic} />
      <C rt={0.14} rb={0.16} h={0.1} p={[0, 0.8, 0]} m={MAT.ceramic} seg={18} />
      <C rt={0.012} rb={0.012} h={0.2} p={[0, 0.88, 0.17]} m={steel} seg={10} />
      {/* mirror */}
      <B s={[0.6, 0.75, 0.02]} p={[0, 1.55, 0.24]} m={steel} />
    </group>
  )
}
Vanity.foot = () => ({ w: 0.74, d: 0.52 })

export function Shower() {
  // closed sides at +x/+z (into the corner walls); glass faces the room
  return (
    <group>
      <B s={[0.9, 0.06, 0.9]} p={[0, 0.03, 0]} m={MAT.ceramic} />
      <B s={[0.9, 2.0, 0.015]} p={[0, 1.06, -0.44]} m={glassy} cast={false} />
      <B s={[0.015, 2.0, 0.9]} p={[-0.44, 1.06, 0]} m={glassy} cast={false} />
      <C rt={0.015} rb={0.015} h={1.1} p={[0.38, 1.5, 0.38]} m={steel} seg={10} />
      <B s={[0.16, 0.02, 0.16]} p={[0.3, 2.05, 0.3]} m={steel} />
    </group>
  )
}
Shower.foot = () => ({ w: 0.95, d: 0.95, cornerOriented: true })
const glassy = plainMaterial({
  color: '#cfe0e8', roughness: 0.05, metalness: 0, transparent: true, opacity: 0.18,
})

export function Desk() {
  return (
    <group>
      <B s={[1.4, 0.03, 0.7]} p={[0, 0.73, 0]} m={deskTop} />
      {[-1, 1].map((k) => (
        <group key={k}>
          <B s={[0.04, 0.7, 0.6]} p={[k * 0.66, 0.37, 0]} m={legMat} />
        </group>
      ))}
      {/* monitor */}
      <B s={[0.56, 0.34, 0.02]} p={[0, 1.05, 0.14]} m={MAT.screen} />
      <B s={[0.04, 0.12, 0.04]} p={[0, 0.82, 0.16]} m={MAT.black} />
      <B s={[0.18, 0.02, 0.14]} p={[0, 0.75, 0.16]} m={MAT.black} />
      {/* keyboard */}
      <B s={[0.36, 0.015, 0.13]} p={[0, 0.75, -0.08]} m={chairShell} />
    </group>
  )
}
Desk.foot = () => ({ w: 1.4, d: 0.7 })

export function OfficeChair() {
  return (
    <group>
      <C rt={0.03, 0.03} rb={0.03} h={0.3} p={[0, 0.35, 0]} m={legMat} seg={10} />
      {[0, 72, 144, 216, 288].map((a) => (
        <B
          key={a}
          s={[0.05, 0.03, 0.3]}
          p={[Math.sin((a * Math.PI) / 180) * 0.14, 0.04, Math.cos((a * Math.PI) / 180) * 0.14]}
          r={[0, (a * Math.PI) / 180, 0]}
          m={legMat}
        />
      ))}
      <B s={[0.48, 0.07, 0.46]} p={[0, 0.52, 0]} m={chairShell} />
      <B s={[0.46, 0.55, 0.07]} p={[0, 0.85, 0.22]} m={chairShell} />
    </group>
  )
}
OfficeChair.foot = () => ({ w: 0.55, d: 0.55 })

export function MeetingTable({ w = 2.6 }) {
  return (
    <group>
      <B s={[w, 0.04, 1.2]} p={[0, 0.73, 0]} m={wood()} />
      <B s={[0.1, 0.71, 0.9]} p={[-w / 2 + 0.35, 0.36, 0]} m={legMat} />
      <B s={[0.1, 0.71, 0.9]} p={[w / 2 - 0.35, 0.36, 0]} m={legMat} />
    </group>
  )
}
MeetingTable.foot = (w = 2.6) => ({ w, d: 1.2 })

export function Whiteboard({ w = 1.8 }) {
  return (
    <group>
      <B s={[w, 1.1, 0.03]} p={[0, 1.55, 0]} m={MAT.whiteboard} />
      <B s={[w + 0.06, 1.16, 0.02]} p={[0, 1.55, 0.012]} m={steel} />
      <B s={[w * 0.6, 0.04, 0.06]} p={[0, 1.02, -0.035]} m={steel} />
    </group>
  )
}
Whiteboard.foot = (w = 1.8) => ({ w, d: 0.08, wallFlush: true })

export function ReceptionDesk({ w = 2.4 }) {
  return (
    <group>
      <B s={[w, 1.1, 0.7]} p={[0, 0.55, 0]} m={wood()} />
      <B s={[w + 0.1, 0.05, 0.8]} p={[0, 1.12, 0]} m={counterTop} />
      <B s={[w - 0.3, 0.03, 0.5]} p={[0, 0.72, 0.15]} m={deskTop} />
      <B s={[0.4, 0.28, 0.02]} p={[0.3, 0.9, 0.2]} m={MAT.screen} />
    </group>
  )
}
ReceptionDesk.foot = (w = 2.4) => ({ w, d: 0.85 })

export function Bookshelf({ w = 1.4 }) {
  const books = plainMaterial({ color: '#7c5a48', roughness: 0.8 })
  const books2 = plainMaterial({ color: '#44607a', roughness: 0.8 })
  // open-fronted: back panel + sides + shelf boards, book rows visible
  return (
    <group>
      <B s={[w, 2.0, 0.03]} p={[0, 1.0, 0.16]} m={wood()} />
      <B s={[0.03, 2.0, 0.36]} p={[-w / 2 + 0.015, 1.0, 0]} m={wood()} />
      <B s={[0.03, 2.0, 0.36]} p={[w / 2 - 0.015, 1.0, 0]} m={wood()} />
      {[0.02, 0.62, 1.22, 1.82].map((y) => (
        <B key={y} s={[w - 0.06, 0.035, 0.36]} p={[0, y + 0.0175, 0]} m={wood()} />
      ))}
      {[0.04, 0.64, 1.24].map((y, i) => (
        <B key={y} s={[w - 0.28, 0.42, 0.22]} p={[(i % 2 ? -1 : 1) * 0.06, y + 0.25, 0.03]} m={i % 2 ? books : books2} />
      ))}
    </group>
  )
}
Bookshelf.foot = (w = 1.4) => ({ w, d: 0.36 })

export function FloorLamp() {
  return (
    <group>
      <C rt={0.14} rb={0.16} h={0.02} p={[0, 0.01, 0]} m={MAT.black} />
      <C rt={0.012} rb={0.012} h={1.5} p={[0, 0.76, 0]} m={MAT.black} seg={8} />
      {/* shade: narrow at the pole (top), flares wide at the open bottom */}
      <C rt={0.1} rb={0.17} h={0.24} p={[0, 1.6, 0]} m={plainMaterial({ color: '#efe5d0', roughness: 0.9 })} />
    </group>
  )
}
FloorLamp.foot = () => ({ w: 0.35, d: 0.35 })

export function BalconySet() {
  return (
    <group>
      <C rt={0.32} rb={0.3} h={0.04} p={[0, 0.7, 0]} m={steel} seg={20} />
      <C rt={0.02} rb={0.02} h={0.7} p={[0, 0.35, 0]} m={steel} seg={10} />
      {[-0.55, 0.55].map((x) => (
        <group key={x} position={[x, 0, 0]} rotation={[0, x > 0 ? Math.PI / 2 : -Math.PI / 2, 0]}>
          <Chair />
        </group>
      ))}
    </group>
  )
}
BalconySet.foot = () => ({ w: 1.8, d: 0.9 })

function legFrame(w, d, h) {
  const inset = 0.06
  return [
    [-w / 2 + inset, -d / 2 + inset],
    [w / 2 - inset, -d / 2 + inset],
    [-w / 2 + inset, d / 2 - inset],
    [w / 2 - inset, d / 2 - inset],
  ].map(([x, z], i) => (
    <mesh key={i} castShadow position={[x, h / 2, z]} material={legMat}>
      <cylinderGeometry args={[0.022, 0.022, h, 10]} />
    </mesh>
  ))
}
