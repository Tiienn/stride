// Sun, sky, stars, and image-based lighting — all driven by the time of day.
// The Environment is re-captured (cheaply, 64px) whenever the hour changes
// enough to matter, so PBR reflections always match the sky.
import * as THREE from 'three'
import { useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import { Sky, Stars, Environment, Lightformer } from '@react-three/drei'
import { useStride } from '../store.js'

export function sunState(hour) {
  const dayFrac = (hour - 6) / 13 // sunrise 06:00, sunset 19:00
  const altitude = Math.sin(Math.PI * dayFrac) * THREE.MathUtils.degToRad(62)
  const azimuth = THREE.MathUtils.degToRad(95 + dayFrac * 150)
  const dir = new THREE.Vector3(
    Math.cos(altitude) * Math.sin(azimuth),
    Math.sin(altitude),
    -Math.cos(altitude) * Math.cos(azimuth)
  )
  const daylight = THREE.MathUtils.clamp(Math.sin(Math.PI * dayFrac) * 1.4, 0, 1)
  // Warmth rises as the sun drops
  const warm = new THREE.Color('#ffb46b')
  const noon = new THREE.Color('#fffaf2')
  const sunColor = warm.clone().lerp(noon, THREE.MathUtils.clamp(altitude / 0.7, 0, 1))
  return { dir, daylight, sunColor, altitude }
}

export default function SunSky({ bounds }) {
  const timeOfDay = useStride((s) => s.timeOfDay)
  const quality = useStride((s) => s.quality)
  const scene = useThree((s) => s.scene)

  const { dir, daylight, sunColor } = useMemo(() => sunState(timeOfDay), [timeOfDay])
  const sunPos = dir.clone().multiplyScalar(90)
  const night = daylight < 0.02

  // Shadow camera sized to the plan
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2 + 6
  const mapSize = quality === 'high' ? 2048 : 1024

  scene.environmentIntensity = 0.12 + daylight * 0.34

  // Re-capture the environment only when lighting shifts meaningfully
  const envKey = Math.round(timeOfDay * 2)

  return (
    <>
      <Sky
        distance={4000}
        sunPosition={sunPos.toArray()}
        turbidity={8}
        rayleigh={night ? 0.15 : 2.4}
        mieCoefficient={0.004}
        mieDirectionalG={0.8}
      />
      {night && <Stars radius={300} depth={60} count={2500} factor={5} fade speed={0.4} />}

      {/* Sun */}
      <directionalLight
        visible={!night}
        position={sunPos.toArray()}
        intensity={daylight * 2.6}
        color={sunColor}
        castShadow
        shadow-mapSize={[mapSize, mapSize]}
        shadow-bias={-0.0003}
        shadow-normalBias={0.04}
        shadow-camera-left={-span}
        shadow-camera-right={span}
        shadow-camera-top={span}
        shadow-camera-bottom={-span}
        shadow-camera-near={2}
        shadow-camera-far={220}
      />
      {/* Moon: a dim, cool stand-in sun at night */}
      <directionalLight
        visible={night}
        position={[-40, 55, -30]}
        intensity={0.12}
        color="#a9bce0"
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0003}
        shadow-normalBias={0.05}
        shadow-camera-left={-span}
        shadow-camera-right={span}
        shadow-camera-top={span}
        shadow-camera-bottom={-span}
        shadow-camera-far={220}
      />
      <hemisphereLight
        intensity={0.08 + daylight * 0.3}
        color={night ? '#25304a' : '#bdd6f5'}
        groundColor={night ? '#11131a' : '#8d8672'}
      />

      {/* Offline IBL: a coarse sky dome + sun disc, captured to a cubemap */}
      <Environment key={envKey} resolution={64} frames={1} background={false}>
        <color attach="background" args={[night ? '#0a0f1c' : '#87a8cf']} />
        <Lightformer
          form="rect"
          scale={[100, 40, 1]}
          position={[0, 40, 0]}
          rotation={[Math.PI / 2, 0, 0]}
          intensity={night ? 0.05 : 0.3 + daylight * 0.25}
          color={night ? '#1c2438' : '#bcd4f2'}
        />
        <Lightformer
          form="rect"
          scale={[100, 30, 1]}
          position={[0, -20, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          intensity={night ? 0.02 : 0.14}
          color={night ? '#0c0e12' : '#94856c'}
        />
        {!night && (
          <Lightformer
            form="circle"
            scale={6}
            position={dir.clone().multiplyScalar(45).toArray()}
            intensity={3.5 * daylight}
            color={sunColor}
          />
        )}
      </Environment>
    </>
  )
}
