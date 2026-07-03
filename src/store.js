import { create } from 'zustand'
import { roomAt } from './lib/planProcess.js'

// Central app state. The 3D scene, HUD and audio all read from here.
export const useStride = create((set, get) => ({
  // App flow
  phase: 'landing', // 'landing' | 'analyzing' | 'walkthrough'
  analysisStatus: '',
  error: null,
  plan: null, // ScenePlan (see lib/planProcess.js)
  planPreview: null, // image URL/dataURL of the 2D plan — shown while the world builds
  lastWalk: null, // { name, steps, distanceM } — parting summary on the landing page

  // Walkthrough state
  steps: 0,
  distanceM: 0,
  currentRoomId: null,
  pointerLocked: false,
  hasWalked: false, // true once the user has entered walk mode at least once
  worldReady: false, // first frames rendered + textures resolved
  lookMode: 'lock', // 'lock' | 'drag' | 'touch' — how the camera is being steered
  notice: null, // transient toast message
  interactHint: null, // { label } shown when aiming at a door/switch
  playerPose: { x: 0, z: 0, yaw: 0 }, // throttled — feeds the minimap

  // Environment
  plotStyle: 'lawn', // site-plan plot ground: 'cleared' | 'meadow' | 'lawn'
  wildStyle: 'lawn', // ground beyond the boundary: 'lawn' | 'meadow'
  timeOfDay: 15.5, // hours, 0-24
  roomLights: {}, // roomId -> boolean
  audioEnabled: true,
  quality: 'high', // 'high' | 'medium' | 'low'
  autoDegraded: false,

  setError: (error) => set({ error }),
  setAnalysisStatus: (analysisStatus) => set({ analysisStatus }),
  startAnalyzing: () => set({ phase: 'analyzing', error: null, analysisStatus: 'Reading your plan…' }),

  enterWalkthrough: (plan, planPreview = null) => {
    const roomLights = {}
    for (const room of plan.rooms || []) roomLights[room.id] = true
    // The HUD's first words should be true: resolve the spawn room up front
    // instead of defaulting to "Outside" until the frame loop ticks.
    const spawnRoom = roomAt(plan, plan.spawn.x, plan.spawn.z)
    set({
      plan,
      planPreview,
      roomLights,
      phase: 'walkthrough',
      steps: 0,
      distanceM: 0,
      currentRoomId: spawnRoom?.id ?? null,
      worldReady: false,
      playerPose: { x: plan.spawn.x, z: plan.spawn.z, yaw: plan.spawn.angle },
      error: null,
      notice: null,
    })
  },

  backToLanding: () =>
    set((s) => ({
      phase: 'landing',
      plan: null,
      planPreview: null,
      error: null,
      analysisStatus: '',
      pointerLocked: false,
      worldReady: false,
      notice: null,
      // a walk worth remembering gets a parting summary on the landing page
      lastWalk:
        s.steps > 30 && s.plan
          ? { name: s.plan.name, steps: s.steps, distanceM: s.distanceM }
          : s.lastWalk,
    })),
  dismissLastWalk: () => set({ lastWalk: null }),

  addStep: () => set((s) => ({ steps: s.steps + 1 })),
  addDistance: (d) => set((s) => ({ distanceM: s.distanceM + d })),
  setCurrentRoom: (currentRoomId) => set({ currentRoomId }),
  setPointerLocked: (pointerLocked) =>
    set((s) => ({ pointerLocked, hasWalked: s.hasWalked || pointerLocked })),
  setWorldReady: (worldReady) => set({ worldReady }),
  setLookMode: (lookMode) => set({ lookMode }),
  setNotice: (notice) => set({ notice }),
  setPlayerPose: (playerPose) => set({ playerPose }),
  setInteractHint: (interactHint) => {
    if (get().interactHint?.label !== interactHint?.label) set({ interactHint })
  },

  setTimeOfDay: (timeOfDay) => set({ timeOfDay }),
  toggleRoomLight: (roomId) =>
    set((s) => ({ roomLights: { ...s.roomLights, [roomId]: !s.roomLights[roomId] } })),
  setAudioEnabled: (audioEnabled) => set({ audioEnabled }),
  setQuality: (quality, autoDegraded = false) => set({ quality, autoDegraded }),
}))
