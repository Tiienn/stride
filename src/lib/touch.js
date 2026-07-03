// Shared, mutable touch-input channel between the on-screen controls (DOM)
// and the Player (render loop). No state library — this is read every frame.
export const touchInput = {
  active: false, // a joystick drag is in progress
  moveX: 0, // -1..1 strafe
  moveY: 0, // -1..1 forward(-)/back(+), screen-space
  lookDX: 0, // accumulated look deltas, consumed (zeroed) by the Player each frame
  lookDY: 0,
}

export const isTouchDevice = () =>
  typeof window !== 'undefined' &&
  ('ontouchstart' in window || navigator.maxTouchPoints > 0)
