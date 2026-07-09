// Turn analyzer furniture detections into world-space placement specs.
//
// The analyzer emits pixel-space boxes on the plan image (plan.furniturePx)
// plus the px->world transform used for everything else (plan.pxToWorld). Each
// detection becomes a spec the room placer can drop at an exact point, so the
// 3D world mirrors how the real plan is furnished. When those fields are
// absent — older plans, site plans, or a run with no detections — we return []
// and the caller falls back to the procedural auto-layout unchanged.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// Sign that converts an image-space clockwise rotation (degrees) into a
// three.js yaw (radians, counter-clockwise about +y). Kept as a single
// named constant because the convention may need exactly one flip after
// visual QA — change it here and nowhere else.
const ROT_SIGN = -1

// A piece sits with its local long axis along +x at yaw 0 (see the ORIENTATION
// CONVENTION note in pieces.jsx). Line that up with the detected symbol.
function rotYFor(widthM, depthM, rotationDeg) {
  // A box taller than wide has its long axis vertical in the image, so the
  // piece needs a quarter turn to match it.
  const longAxisVertical = depthM > widthM
  if (typeof rotationDeg === 'number' && Number.isFinite(rotationDeg)) {
    let r = ROT_SIGN * rotationDeg * Math.PI / 180
    if (longAxisVertical) r += Math.PI / 2
    return r
  }
  // No rotation given: infer the two cardinal orientations from the box shape.
  return widthM >= depthM ? 0 : Math.PI / 2
}

// type -> how to realize it as a placed piece. The factory receives the
// derived metric dimensions { widthM, depthM, long, short } and returns the
// piece export name, its props, the args to reconstruct its footprint, and its
// visual height (used by the placer's window/erosion checks). `null` means the
// detection has no standalone piece (e.g. a hob lives inside the kitchen run).
const MAP = {
  bed: (d) => {
    const w = clamp(d.widthM, 0.9, 2.0)
    return { pieceKey: 'Bed', props: { w }, footArgs: [w], height: 1.1 }
  },
  sofa: (d) => {
    const w = clamp(d.long, 1.4, 2.6)
    return { pieceKey: 'Sofa', props: { w }, footArgs: [w], height: 1 }
  },
  armchair: () => ({ pieceKey: 'LoungeChair', props: {}, footArgs: [], height: 1 }),
  dining_table: (d) => {
    const seats = d.long > 1.8 ? 6 : 4
    return { pieceKey: 'DiningSet', props: { seats }, footArgs: [seats], height: 1 }
  },
  coffee_table: () => ({ pieceKey: 'CoffeeTable', props: {}, footArgs: [], height: 0.45 }),
  desk: () => ({ pieceKey: 'Desk', props: {}, footArgs: [], height: 1.2 }),
  chair: () => ({ pieceKey: 'Chair', props: {}, footArgs: [], height: 1 }),
  wardrobe: (d) => {
    const w = clamp(d.long, 0.8, 2.4)
    return { pieceKey: 'Wardrobe', props: { w }, footArgs: [w], height: 2.2 }
  },
  bookshelf: (d) => {
    const w = clamp(d.long, 0.8, 2.0)
    return { pieceKey: 'Bookshelf', props: { w }, footArgs: [w], height: 2.0 }
  },
  tv_unit: (d) => {
    const w = clamp(d.long, 1.2, 2.0)
    return { pieceKey: 'TVUnit', props: { w }, footArgs: [w], height: 1.4 }
  },
  kitchen_run: (d) => {
    const w = clamp(d.long, 1.2, 4.0)
    return { pieceKey: 'KitchenRun', props: { w }, footArgs: [w], height: 2.3 }
  },
  fridge: () => ({ pieceKey: 'Fridge', props: {}, footArgs: [], height: 1.9 }),
  sink: () => ({ pieceKey: 'Vanity', props: {}, footArgs: [], height: 1.7 }),
  washbasin: () => ({ pieceKey: 'Vanity', props: {}, footArgs: [], height: 1.7 }),
  toilet: () => ({ pieceKey: 'Toilet', props: {}, footArgs: [], height: 0.8 }),
  shower: () => ({ pieceKey: 'Shower', props: {}, footArgs: [], height: 2.2 }),
  bathtub: () => ({ pieceKey: 'Shower', props: {}, footArgs: [], height: 2.2 }),
  plant: () => ({ pieceKey: 'Plant', props: {}, footArgs: [], height: 1.7 }),
  rug: (d) => {
    const w = clamp(d.long, 1, 3.4)
    const dp = clamp(d.short, 0.8, 2.6)
    return { pieceKey: 'Rug', props: { w, d: dp }, footArgs: [w, dp], walkable: true }
  },
  hob: null, // drawn as part of the kitchen run — no standalone piece
}

export function mapDetectedFurniture(plan) {
  const dets = plan && plan.furniturePx
  const t = plan && plan.pxToWorld
  if (!Array.isArray(dets) || !dets.length || !t || !(t.ppm > 0)) return []
  const { ppm, cx, cy } = t

  const specs = []
  for (const det of dets) {
    if (!det || !det.center) continue
    const make = MAP[det.type]
    if (!make) continue // unknown type, or intentionally skipped (e.g. hob)

    const widthM = det.width / ppm
    const depthM = det.depth / ppm
    const long = Math.max(det.width, det.depth) / ppm
    const short = Math.min(det.width, det.depth) / ppm
    const base = make({ widthM, depthM, long, short })
    if (!base) continue

    specs.push({
      pieceKey: base.pieceKey,
      props: base.props || {},
      footArgs: base.footArgs || [],
      x: (det.center.x - cx) / ppm,
      z: (det.center.y - cy) / ppm,
      rotY: rotYFor(widthM, depthM, det.rotationDeg),
      height: base.height ?? 1,
      walkable: !!base.walkable,
    })
  }
  return specs
}
