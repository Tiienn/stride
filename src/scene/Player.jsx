// First-person controller: WASD + pointer-lock mouse look, capsule collision
// against walls/doors/furniture, head bob that drives the step counter and
// surface-aware footstep sounds, and crosshair interaction with doors and
// light switches.
import * as THREE from 'three'
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { PointerLockControls } from '@react-three/drei'
import { collisionSegments, roomAt, pointInPolygon } from '../lib/planProcess.js'
import { makeTerrain } from '../lib/terrain.js'
import { roomConfig } from '../lib/roomTypes.js'
import { interactables, colliders, doorSegments } from '../lib/interact.js'
import { touchInput, isTouchDevice } from '../lib/touch.js'
import { useStride } from '../store.js'
import { audio } from '../lib/audio.js'

const EYE = 1.62
const RADIUS = 0.28
const WALK = 2.0
const RUN = 3.6
const JUMP_V = 3.7 // m/s launch — ~0.62 m hop
const GRAVITY = 11

export default function Player({ plan }) {
  const camera = useThree((s) => s.camera)
  const controls = useRef()
  const keys = useRef({})
  const vel = useRef(new THREE.Vector3())
  const bobPhase = useRef(0)
  const lastStepIdx = useRef(0)
  const roomTimer = useRef(0)
  const poseTimer = useRef(0)
  const baseY = useRef(EYE) // camera Y minus the jump offset (ground + bob)
  const jumpH = useRef(0) // current hop height above the ground
  const velY = useRef(0)
  const jumpQueued = useRef(false)
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const currentHint = useRef(null)

  const segments = useMemo(() => collisionSegments(plan), [plan])
  const terrain = useMemo(() => makeTerrain(plan), [plan])

  if (import.meta.env.DEV) {
    window.__strideDebug = { keys: keys.current, camera, vel: vel.current }
  }

  // Spawn
  useEffect(() => {
    camera.rotation.order = 'YXZ'
    const groundY = terrain.rolling ? terrain.heightAt(plan.spawn.x, plan.spawn.z) : 0
    camera.position.set(plan.spawn.x, EYE + groundY, plan.spawn.z)
    camera.rotation.set(0, plan.spawn.angle, 0)
    vel.current.set(0, 0, 0)
    baseY.current = EYE + groundY
    jumpH.current = 0
    velY.current = 0
  }, [plan, camera, terrain])

  // Input. Pointer lock is the primary look mode. If it's unavailable
  // (embedded previews, denied permission) we fall back to drag-to-look —
  // but only on an explicit pointerlockerror or a generous timeout, never on
  // a fast heuristic: browsers reject re-lock requests for ~1.3s after Esc,
  // and treating that cooldown as "unsupported" would strand desktop users
  // in drag mode. The HUD also disables Resume during that window.
  const fallbackLook = useRef(false)
  useEffect(() => {
    const touch = isTouchDevice()
    let backstop = null

    const engageFallback = (mode) => {
      clearTimeout(backstop)
      fallbackLook.current = true
      const st = useStride.getState()
      st.setLookMode(mode)
      st.setPointerLocked(true)
      if (mode === 'drag') st.setNotice('Mouse capture unavailable — drag to look around')
    }

    const down = (e) => {
      keys.current[e.code] = true
      if (e.code === 'KeyE') tryInteract()
      if (e.code === 'Space' && useStride.getState().pointerLocked) {
        e.preventDefault() // don't scroll the page
        if (!e.repeat) jumpQueued.current = true
      }
      if (e.code === 'Escape' && fallbackLook.current) {
        useStride.getState().setPointerLocked(false)
      }
    }
    const up = (e) => (keys.current[e.code] = false)
    const click = (e) => {
      if (useStride.getState().pointerLocked && !e._strideDrag) tryInteract()
    }
    const interactReq = () => tryInteract()
    const lockReq = () => {
      // touch devices and an already-engaged fallback skip the lock API entirely
      if (touch) {
        engageFallback('touch')
        return
      }
      if (fallbackLook.current) {
        useStride.getState().setPointerLocked(true)
        return
      }
      try {
        controls.current?.lock()
      } catch {
        /* pointerlockerror handles it */
      }
      // Backstop only: the spec fires pointerlockchange or pointerlockerror
      // for every request — this catches the rare browser that does neither.
      clearTimeout(backstop)
      backstop = setTimeout(() => {
        if (!document.pointerLockElement && !fallbackLook.current) engageFallback('drag')
      }, 1500)
    }
    const lockError = () => engageFallback('drag')
    const lockChange = () => {
      if (document.pointerLockElement) clearTimeout(backstop)
    }

    let dragging = false
    let lastX = 0
    let lastY = 0
    let movedPx = 0
    const mDown = (e) => {
      if (!fallbackLook.current || !useStride.getState().pointerLocked) return
      dragging = true
      movedPx = 0
      lastX = e.clientX
      lastY = e.clientY
    }
    const mMove = (e) => {
      if (!dragging) return
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      movedPx += Math.abs(dx) + Math.abs(dy)
      lastX = e.clientX
      lastY = e.clientY
      camera.rotation.y -= dx * 0.0042
      camera.rotation.x = Math.max(-1.45, Math.min(1.45, camera.rotation.x - dy * 0.0042))
    }
    const mUp = (e) => {
      if (dragging && movedPx > 6) e._strideDrag = true
      dragging = false
    }

    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('mouseup', click)
    window.addEventListener('stride:lock', lockReq)
    window.addEventListener('stride:interact', interactReq)
    document.addEventListener('pointerlockerror', lockError)
    document.addEventListener('pointerlockchange', lockChange)
    window.addEventListener('mousedown', mDown)
    window.addEventListener('mousemove', mMove)
    window.addEventListener('mouseup', mUp, true)
    return () => {
      clearTimeout(backstop)
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('mouseup', click)
      window.removeEventListener('stride:lock', lockReq)
      window.removeEventListener('stride:interact', interactReq)
      document.removeEventListener('pointerlockerror', lockError)
      document.removeEventListener('pointerlockchange', lockChange)
      window.removeEventListener('mousedown', mDown)
      window.removeEventListener('mousemove', mMove)
      window.removeEventListener('mouseup', mUp, true)
    }
  }, [camera])

  function tryInteract() {
    const hint = currentHint.current
    if (hint?.entry) hint.entry.action()
  }

  function surfaceAt(x, z) {
    if (plan.planType === 'site') {
      const re = plan.site.roadEdge
      if (re) {
        const u = { x: re.end.x - re.start.x, z: re.end.z - re.start.z }
        const len = Math.hypot(u.x, u.z)
        u.x /= len; u.z /= len
        const mid = { x: (re.start.x + re.end.x) / 2, z: (re.start.z + re.end.z) / 2 }
        const c = plan.site.centroid
        let n = { x: mid.x - c.x, z: mid.z - c.z }
        const d = n.x * u.x + n.z * u.z
        n = { x: n.x - u.x * d, z: n.z - u.z * d }
        const nl = Math.hypot(n.x, n.z) || 1
        n.x /= nl; n.z /= nl
        const perp = (x - mid.x) * n.x + (z - mid.z) * n.z
        if (perp > 2.0 && perp < 7.5) return 'concrete' // asphalt
        if (perp > 0.2 && perp <= 2.0) return 'gravel'
      }
      return 'grass'
    }
    const room = roomAt(plan, x, z)
    if (room) return roomConfig(room.type).surface
    const b = plan.bounds
    if (x > b.minX - 1.4 && x < b.maxX + 1.4 && z > b.minZ - 1.4 && z < b.maxZ + 1.4) return 'concrete'
    return 'grass'
  }

  function resolveCollisions(pos) {
    for (let iter = 0; iter < 3; iter++) {
      let pushed = false
      const all = [...segments, ...doorSegments.values()]
      for (const s of all) {
        const abx = s.bx - s.ax, abz = s.bz - s.az
        const lenSq = abx * abx + abz * abz || 1e-9
        let t = ((pos.x - s.ax) * abx + (pos.z - s.az) * abz) / lenSq
        t = Math.max(0, Math.min(1, t))
        const px = s.ax + abx * t, pz = s.az + abz * t
        let dx = pos.x - px, dz = pos.z - pz
        const dist = Math.hypot(dx, dz)
        const minDist = RADIUS + s.r
        if (dist < minDist) {
          if (dist < 1e-5) { dx = 1; dz = 0 }
          else { dx /= dist; dz /= dist }
          pos.x = px + dx * minDist
          pos.z = pz + dz * minDist
          pushed = true
        }
      }
      for (const b of colliders) {
        const cx = Math.max(b.minX, Math.min(b.maxX, pos.x))
        const cz = Math.max(b.minZ, Math.min(b.maxZ, pos.z))
        let dx = pos.x - cx, dz = pos.z - cz
        const dist = Math.hypot(dx, dz)
        if (dist < RADIUS) {
          if (dist < 1e-5) {
            // center inside the box — push out the nearest face
            const exits = [
              [b.minX - RADIUS - pos.x, 0], [b.maxX + RADIUS - pos.x, 0],
              [0, b.minZ - RADIUS - pos.z], [0, b.maxZ + RADIUS - pos.z],
            ].sort((p, q) => Math.hypot(...p) - Math.hypot(...q))
            pos.x += exits[0][0]; pos.z += exits[0][1]
          } else {
            pos.x = cx + (dx / dist) * RADIUS
            pos.z = cz + (dz / dist) * RADIUS
          }
          pushed = true
        }
      }
      if (!pushed) break
    }
    // keep site walks within a sane range
    if (plan.planType === 'site') {
      const c = plan.site.centroid
      const dx = pos.x - c.x, dz = pos.z - c.z
      const d = Math.hypot(dx, dz)
      const maxR = Math.max(plan.bounds.maxX - plan.bounds.minX, plan.bounds.maxZ - plan.bounds.minZ) * 1.6 + 25
      if (d > maxR) {
        pos.x = c.x + (dx / d) * maxR
        pos.z = c.z + (dz / d) * maxR
      }
    }
    return pos
  }

  useFrame((state, dt) => {
    if (import.meta.env.DEV) window.__strideFrames = (window.__strideFrames || 0) + 1
    const st = useStride.getState()
    const locked = st.pointerLocked
    dt = Math.min(dt, 0.05)

    // Touch look: consume deltas accumulated by the on-screen controls
    if (locked && (touchInput.lookDX || touchInput.lookDY)) {
      camera.rotation.y -= touchInput.lookDX * 0.0044
      camera.rotation.x = Math.max(
        -1.45,
        Math.min(1.45, camera.rotation.x - touchInput.lookDY * 0.0044)
      )
      touchInput.lookDX = 0
      touchInput.lookDY = 0
    }

    // Desired velocity from input, in camera yaw space
    const k = keys.current
    let fwd = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0)
    let strafe = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0)
    if (touchInput.active) {
      fwd += -touchInput.moveY
      strafe += touchInput.moveX
    }
    const running = k.ShiftLeft || k.ShiftRight
    const speed = running ? RUN : WALK

    const yaw = camera.rotation.y
    const dirX = -Math.sin(yaw) * fwd + Math.cos(yaw) * strafe
    const dirZ = -Math.cos(yaw) * fwd - Math.sin(yaw) * strafe
    const mag = Math.hypot(dirX, dirZ)
    const target = new THREE.Vector3()
    if (locked && mag > 0.02) {
      // clamp rather than normalize so a half-tilted joystick walks slower
      const scale = speed * Math.min(1, mag) / mag
      target.set(dirX * scale, 0, dirZ * scale)
    }

    vel.current.x = THREE.MathUtils.damp(vel.current.x, target.x, 12, dt)
    vel.current.z = THREE.MathUtils.damp(vel.current.z, target.z, 12, dt)

    const before = { x: camera.position.x, z: camera.position.z }
    const pos = {
      x: camera.position.x + vel.current.x * dt,
      z: camera.position.z + vel.current.z * dt,
    }
    resolveCollisions(pos)
    camera.position.x = pos.x
    camera.position.z = pos.z

    // Actual speed after collisions drives bob, steps, distance
    const moved = Math.hypot(pos.x - before.x, pos.z - before.z)
    const actualSpeed = moved / Math.max(dt, 1e-4)
    if (moved > 0.0004) st.addDistance(moved)

    if (actualSpeed > 0.4) {
      const stepHz = running ? 2.35 : 1.8
      bobPhase.current += dt * stepHz * Math.PI * (actualSpeed / speed + 0.35)
      const stepIdx = Math.floor(bobPhase.current / Math.PI)
      if (stepIdx > lastStepIdx.current) {
        lastStepIdx.current = stepIdx
        st.addStep()
        audio.footstep(surfaceAt(pos.x, pos.z), running ? 1.3 : 1)
      }
    }
    const bobAmp = actualSpeed > 0.4 ? (running ? 0.045 : 0.03) : 0
    // feet follow the rolling terrain (flat inside the plot and on roads)
    const groundY = terrain.rolling ? terrain.heightAt(pos.x, pos.z) : 0

    // Jump: a gravity-integrated hop added on top of the smoothly-damped
    // ground+bob base, so terrain stays smooth but the hop stays crisp.
    const grounded = jumpH.current <= 0.0001 && velY.current <= 0
    if (jumpQueued.current && grounded && locked) velY.current = JUMP_V
    jumpQueued.current = false
    if (!grounded || velY.current > 0) {
      velY.current -= GRAVITY * dt
      jumpH.current += velY.current * dt
      if (jumpH.current <= 0) {
        jumpH.current = 0
        velY.current = 0
        audio.footstep(surfaceAt(pos.x, pos.z), 1.3) // landing
      }
    }

    const baseTarget = EYE + groundY + Math.sin(bobPhase.current * 2) * (grounded ? bobAmp : 0)
    baseY.current = THREE.MathUtils.damp(baseY.current, baseTarget, 14, dt)
    camera.position.y = baseY.current + jumpH.current

    // Publish pose for the minimap (10x/sec, only when it actually changed)
    poseTimer.current -= dt
    if (poseTimer.current <= 0) {
      poseTimer.current = 0.1
      const prev = st.playerPose
      if (
        Math.abs(prev.x - pos.x) > 0.02 ||
        Math.abs(prev.z - pos.z) > 0.02 ||
        Math.abs(prev.yaw - camera.rotation.y) > 0.02
      ) {
        st.setPlayerPose({ x: pos.x, z: pos.z, yaw: camera.rotation.y })
      }
    }

    // Room tracking + audio environment (5x/sec)
    roomTimer.current -= dt
    if (roomTimer.current <= 0) {
      roomTimer.current = 0.2
      const room = plan.planType === 'site' ? null : roomAt(plan, pos.x, pos.z)
      st.setCurrentRoom(room?.id ?? null)
      const outside =
        plan.planType === 'site' ||
        (!room && !(plan.planType !== 'site' && pointInPolygon(
          { x: pos.x, z: pos.z },
          [
            { x: plan.bounds.minX, z: plan.bounds.minZ },
            { x: plan.bounds.maxX, z: plan.bounds.minZ },
            { x: plan.bounds.maxX, z: plan.bounds.maxZ },
            { x: plan.bounds.minX, z: plan.bounds.maxZ },
          ]
        )))
      audio.setEnvironment({
        profile: outside ? 'exterior' : plan.planType === 'office' ? 'office' : 'home',
        hour: st.timeOfDay,
        roomArea: room?.area ?? 24,
      })

      // Interaction raycast (also 5x/sec — cheap and responsive enough)
      if (interactables.size > 0) {
        raycaster.setFromCamera({ x: 0, y: 0 }, camera)
        raycaster.far = 2.7
        const objects = [...interactables.values()].map((e) => e.object)
        const hits = raycaster.intersectObjects(objects, true)
        let entry = null
        if (hits.length) {
          let o = hits[0].object
          while (o && !o.userData.interactId) o = o.parent
          if (o) entry = interactables.get(o.userData.interactId)
        }
        currentHint.current = entry ? { entry } : null
        st.setInteractHint(entry ? { label: entry.label() } : null)
      }
    }
  })

  return (
    // selector matching nothing: drei would otherwise bind click-to-lock on
    // the whole document, so clicking any HUD chip while paused would yank
    // the pointer back into the world. Locking goes through 'stride:lock'.
    <PointerLockControls
      ref={controls}
      selector="#stride-explicit-lock-only"
      onLock={() => useStride.getState().setPointerLocked(true)}
      onUnlock={() => useStride.getState().setPointerLocked(false)}
    />
  )
}
