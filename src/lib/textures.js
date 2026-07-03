// PBR material library. Loads the bundled ambientCG (CC0) texture sets once,
// hands out cached MeshStandardMaterial instances per (surface, repeat).
import * as THREE from 'three'

const SETS = {
  earthPatchy: {}, // cleared plot: graded earth with patchy regrowth
  meadow: {}, // fine olive grass — tinted warm for a dry-meadow look
  lawn: {}, // fresh fine-bladed lawn green
  woodFloor: { ao: true },
  carpet: { ao: true },
  tiles: {},
  concrete: {},
  plaster: {},
  grass: { ao: true },
  asphalt: {},
  ground: { ao: true },
  woodFurniture: { ao: true },
  fabric: {},
  pavingStones: { ao: true },
}

const loader = new THREE.TextureLoader()
const texCache = new Map()
const matCache = new Map()

function loadTex(url, { srgb = false, repeat = 1 } = {}) {
  const key = `${url}|${srgb}|${repeat}`
  if (texCache.has(key)) return texCache.get(key)
  const base = `${url}|${srgb}`
  let tex
  if (texCache.has(base) && texCache.get(base).image) {
    // safe to clone only once the source image exists — a clone made
    // before load would keep a null image forever
    tex = texCache.get(base).clone()
  } else if (texCache.has(base)) {
    tex = loader.load(url)
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace
  } else {
    tex = loader.load(url)
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace
    texCache.set(base, tex)
    if (repeat === 1) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping
      tex.anisotropy = 8
      texCache.set(key, tex)
      return tex
    }
  }
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 8
  tex.repeat.set(repeat, repeat)
  texCache.set(key, tex)
  return tex
}

export function surfaceMaps(name, repeat = 1) {
  const cfg = SETS[name]
  if (!cfg) throw new Error(`Unknown surface ${name}`)
  const base = `/textures/${name}`
  const maps = {
    map: loadTex(`${base}/color.jpg`, { srgb: true, repeat }),
    normalMap: loadTex(`${base}/normal.jpg`, { repeat }),
    roughnessMap: loadTex(`${base}/roughness.jpg`, { repeat }),
  }
  if (cfg.ao) {
    maps.aoMap = loadTex(`${base}/ao.jpg`, { repeat })
    maps.aoMap.channel = 0 // sample AO with the primary UVs
  }
  return maps
}

// Cached standard material for a surface. `repeat` is texture tiles per UV
// unit — geometry built with world-space UVs (1 unit = 1 m) should pass
// roughly 1/textureWorldSize.
export function surfaceMaterial(name, { repeat = 1, ...overrides } = {}) {
  const key = `${name}|${repeat}|${JSON.stringify(overrides)}`
  if (matCache.has(key)) return matCache.get(key)
  const mat = new THREE.MeshStandardMaterial({
    ...surfaceMaps(name, repeat),
    ...overrides,
  })
  matCache.set(key, mat)
  return mat
}

// Ground material tuned for large outdoor planes. Two problems with naively
// tiling a 2m grass photo across 400m: (1) the roughness map makes sun
// glints — grass reads as wet plastic; (2) the repeats blur into a smeared
// "liquid" look at distance. Fix: matte (roughness 1, faint env), and blend
// the texture with itself at a much larger scale, masked by a low-frequency
// sample, so no two patches repeat in step.
export function groundMaterial(name, { repeat = 1, tint, farColor = '#77705a' } = {}) {
  const key = `ground|${name}|${repeat}|${tint || ''}|${farColor}`
  if (matCache.has(key)) return matCache.get(key)
  const base = `/textures/${name}`
  const mat = new THREE.MeshStandardMaterial({
    map: loadTex(`${base}/color.jpg`, { srgb: true, repeat }),
    normalMap: loadTex(`${base}/normal.jpg`, { repeat }),
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.22,
    ...(tint && !Array.isArray(tint) ? { color: tint } : {}),
  })
  // array tint may exceed 1.0 per channel — a multiply tint can only darken,
  // so brightening (e.g. sun-bleached gold) needs super-white values
  if (Array.isArray(tint)) mat.color.setRGB(...tint)
  mat.map.anisotropy = 16
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.gFarColor = { value: new THREE.Color(farColor) }
    shader.fragmentShader =
      'uniform vec3 gFarColor;\n' +
      shader.fragmentShader.replace(
        '#include <map_fragment>',
        /* glsl */ `
        #ifdef USE_MAP
          vec4 gc1 = texture2D( map, vMapUv );
          vec4 gc2 = texture2D( map, vMapUv * 0.1317 + vec2( 0.31, 0.67 ) );
          float gmask = smoothstep( 0.25, 0.75, texture2D( map, vMapUv * 0.0193 ).g );
          vec4 sampledDiffuseColor = mix( gc1, gc2 * vec4( 0.94, 1.02, 0.9, 1.0 ), 0.28 + 0.44 * gmask );
          // Distant ground converges to the texture's (dark) mip average —
          // blend toward a chosen far tone instead, like real terrain haze.
          float gfar = smoothstep( 22.0, 130.0, length( vViewPosition ) );
          sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, gFarColor, gfar * 0.6 );
          diffuseColor *= sampledDiffuseColor;
        #endif
        `
      )
  }
  matCache.set(key, mat)
  return mat
}

// Photo-free ground: the color is computed from layered value noise in the
// shader, so there is no texture to tile and no mip average to go muddy —
// variation is infinite and the palette is exactly what we choose. Used for
// the wild land around site plots, under the instanced grass field.
export function proceduralGroundMaterial({
  colorA = '#4e6d33', // deep grass green
  colorB = '#6d8f46', // bright grass green
  colorDry = '#8a9455', // warm dry patches
  farColor = '#66804a',
} = {}) {
  const key = `procGround|${colorA}|${colorB}|${colorDry}|${farColor}`
  if (matCache.has(key)) return matCache.get(key)
  const mat = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.22,
  })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.gColA = { value: new THREE.Color(colorA) }
    shader.uniforms.gColB = { value: new THREE.Color(colorB) }
    shader.uniforms.gColDry = { value: new THREE.Color(colorDry) }
    shader.uniforms.gFar = { value: new THREE.Color(farColor) }

    shader.vertexShader =
      'varying vec2 vGroundW;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vGroundW = (modelMatrix * vec4( position, 1.0 )).xz;`
      )

    shader.fragmentShader =
      `
      varying vec2 vGroundW;
      uniform vec3 gColA;
      uniform vec3 gColB;
      uniform vec3 gColDry;
      uniform vec3 gFar;
      float gHash( vec2 p ) {
        return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
      }
      float gNoise( vec2 p ) {
        vec2 i = floor( p );
        vec2 f = fract( p );
        f = f * f * ( 3.0 - 2.0 * f );
        return mix(
          mix( gHash( i ), gHash( i + vec2( 1.0, 0.0 ) ), f.x ),
          mix( gHash( i + vec2( 0.0, 1.0 ) ), gHash( i + vec2( 1.0, 1.0 ) ), f.x ),
          f.y
        );
      }
      ` +
      shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          // three octaves: broad meadow variation, mid clumps, fine grain
          float nBig = gNoise( vGroundW * 0.021 );
          float nMid = gNoise( vGroundW * 0.13 + 17.0 );
          float nFine = gNoise( vGroundW * 1.7 + 31.0 );
          vec3 g = mix( gColA, gColB, clamp( nBig * 0.85 + nMid * 0.35, 0.0, 1.0 ) );
          float dry = smoothstep( 0.62, 0.85, gNoise( vGroundW * 0.043 + 53.0 ) );
          g = mix( g, gColDry, dry * 0.5 );
          g *= 0.92 + nFine * 0.16;
          float gfar = smoothstep( 25.0, 140.0, length( vViewPosition ) );
          g = mix( g, gFar, gfar * 0.55 );
          diffuseColor.rgb *= g;
        }`
      )
  }
  matCache.set(key, mat)
  return mat
}

// Plain (untextured) helpers for trim, fixtures, furniture accents.
const plainCache = new Map()
export function plainMaterial(props) {
  const key = JSON.stringify(props)
  if (plainCache.has(key)) return plainCache.get(key)
  const mat = new THREE.MeshStandardMaterial(props)
  plainCache.set(key, mat)
  return mat
}

export const MAT = {
  get trim() { return plainMaterial({ color: '#f4f1ea', roughness: 0.45, metalness: 0 }) },
  get doorLeaf() { return plainMaterial({ color: '#e9e4da', roughness: 0.4 }) },
  get doorDark() { return plainMaterial({ color: '#3d4046', roughness: 0.5 }) },
  get handle() { return plainMaterial({ color: '#b8b2a6', roughness: 0.25, metalness: 0.9 }) },
  get metal() { return plainMaterial({ color: '#9aa0a8', roughness: 0.35, metalness: 0.85 }) },
  get black() { return plainMaterial({ color: '#17181c', roughness: 0.6 }) },
  get white() { return plainMaterial({ color: '#fafafa', roughness: 0.85 }) },
  get ceiling() { return plainMaterial({ color: '#f6f5f2', roughness: 0.95 }) },
  get ceramic() { return plainMaterial({ color: '#f2f4f5', roughness: 0.12, metalness: 0 }) },
  get plantGreen() { return plainMaterial({ color: '#3d6b35', roughness: 0.9 }) },
  get plantPot() { return plainMaterial({ color: '#8a8378', roughness: 0.8 }) },
  get screen() { return plainMaterial({ color: '#0a0c10', roughness: 0.15, metalness: 0.3 }) },
  get whiteboard() { return plainMaterial({ color: '#f8f9fa', roughness: 0.15 }) },
  get treeTrunk() { return plainMaterial({ color: '#5c4a38', roughness: 0.95 }) },
  get foliage() { return plainMaterial({ color: '#4a7040', roughness: 0.95 }) },
  get foliageDark() { return plainMaterial({ color: '#3a5c33', roughness: 0.95 }) },
}

// Scale a BoxGeometry's UVs so textures tile in world units (1 UV = 1 m).
// BoxGeometry face order: +x, -x, +y, -y, +z, -z (4 verts each).
export function worldUVsBox(geom, w, h, d) {
  const uv = geom.attributes.uv
  const dims = [
    [d, h], [d, h], // ±x
    [w, d], [w, d], // ±y
    [w, h], [w, h], // ±z
  ]
  for (let f = 0; f < 6; f++) {
    const [su, sv] = dims[f]
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v
      uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv)
    }
  }
  uv.needsUpdate = true
  return geom
}
