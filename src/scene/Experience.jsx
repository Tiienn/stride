// The renderer shell: canvas configuration, tone mapping, postprocessing
// stack (AO, bloom, vignette) and an FPS watchdog that steps quality down
// rather than letting the walk stutter.
import * as THREE from 'three'
import { useEffect, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useProgress } from '@react-three/drei'
import { EffectComposer, Bloom, Vignette, N8AO } from '@react-three/postprocessing'
import SunSky from './SunSky.jsx'
import InteriorWorld from './Interior.jsx'
import SiteWorld from './Exterior.jsx'
import Player from './Player.jsx'
import { useStride } from '../store.js'
import { clearAllRegistries } from '../lib/interact.js'

const DPR = { high: [1, 1.75], medium: [1, 1.25], low: [0.75, 1] }

// Flags the store once the world is actually visible: a few frames rendered
// and no assets still in flight. The HUD holds a "Building your world" veil
// until this fires, so users never stare at a black canvas.
function ReadyProbe() {
  const frames = useRef(0)
  useFrame(() => {
    if (useStride.getState().worldReady) return
    frames.current++
    // read imperatively — subscribing would make texture loads (which fire
    // during other components' renders) trigger setState-in-render warnings
    if (frames.current > 3 && !useProgress.getState().active) {
      useStride.getState().setWorldReady(true)
    }
  })
  return null
}

// Dev-only: lets tooling drive frames manually (hidden tabs pause rAF)
function DevHandle() {
  const state = useThree()
  useEffect(() => {
    if (import.meta.env.DEV) window.__r3f = state
  }, [state])
  return null
}

function QualityWatchdog() {
  // Long initial cooldown: shader compilation makes the first seconds stutter
  // on any machine — don't let that trigger a degrade.
  const acc = useRef({ t: 0, frames: 0, cooldown: 12 })
  useFrame((_, dt) => {
    const a = acc.current
    a.t += dt
    a.frames++
    if (a.cooldown > 0) {
      a.cooldown -= dt
      if (a.t > 1) { a.t = 0; a.frames = 0 }
      return
    }
    if (a.t >= 3) {
      const fps = a.frames / a.t
      a.t = 0
      a.frames = 0
      const { quality, setQuality } = useStride.getState()
      if (fps < 38 && quality === 'high') {
        setQuality('medium', true)
        a.cooldown = 6
      } else if (fps < 27 && quality === 'medium') {
        setQuality('low', true)
        a.cooldown = 6
      }
    }
  })
  return null
}

function PostFX() {
  const quality = useStride((s) => s.quality)
  if (quality === 'low') return null
  return (
    <EffectComposer multisampling={quality === 'high' ? 4 : 0}>
      <N8AO
        aoRadius={0.9}
        intensity={2.8}
        distanceFalloff={0.9}
        quality={quality === 'high' ? 'medium' : 'performance'}
        halfRes={quality !== 'high'}
      />
      <Bloom luminanceThreshold={1.2} intensity={0.22} mipmapBlur />
      <Vignette eskil={false} offset={0.16} darkness={0.52} />
    </EffectComposer>
  )
}

export default function Experience() {
  const plan = useStride((s) => s.plan)
  const quality = useStride((s) => s.quality)

  useEffect(() => {
    // Fresh registries per plan; heuristic initial quality
    clearAllRegistries()
    const small = Math.min(window.innerWidth, window.innerHeight) < 500
    const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
    if (mobile || small) useStride.getState().setQuality('low')
    return clearAllRegistries
  }, [plan])

  if (!plan) return null

  return (
    <Canvas
      shadows={{ type: THREE.PCFSoftShadowMap }}
      dpr={DPR[quality]}
      gl={{
        antialias: true,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 0.95,
        powerPreference: 'high-performance',
      }}
      camera={{ fov: 71, near: 0.06, far: 600 }}
    >
      {/* haze starts close enough to dissolve the tiled far ground into air */}
      <fog attach="fog" args={['#ccd5e0', 55, 260]} />
      <SunSky bounds={plan.bounds} />
      {plan.planType === 'site' ? <SiteWorld plan={plan} /> : <InteriorWorld plan={plan} />}
      <Player plan={plan} />
      <PostFX />
      <QualityWatchdog />
      <ReadyProbe />
      {import.meta.env.DEV && <DevHandle />}
    </Canvas>
  )
}
