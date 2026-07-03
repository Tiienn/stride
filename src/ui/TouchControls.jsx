// On-screen controls for touch devices: left thumb = virtual joystick to
// move, right thumb = drag to look, short tap = interact. Writes into the
// shared touchInput channel that the Player consumes each frame.
import { useEffect, useRef, useState } from 'react'
import { touchInput } from '../lib/touch.js'

const STICK_R = 46 // px travel radius

export default function TouchControls() {
  const [stick, setStick] = useState(null) // { baseX, baseY, dx, dy }
  const moveId = useRef(null)
  const lookId = useRef(null)
  const look = useRef({ x: 0, y: 0, moved: 0, t: 0 })

  useEffect(() => {
    return () => {
      touchInput.active = false
      touchInput.moveX = 0
      touchInput.moveY = 0
    }
  }, [])

  const onMoveDown = (e) => {
    if (moveId.current !== null) return
    e.preventDefault()
    moveId.current = e.pointerId
    e.currentTarget.setPointerCapture(e.pointerId)
    setStick({ baseX: e.clientX, baseY: e.clientY, dx: 0, dy: 0 })
    touchInput.active = true
  }
  const onMovePointer = (e) => {
    if (e.pointerId !== moveId.current) return
    setStick((s) => {
      if (!s) return s
      let dx = e.clientX - s.baseX
      let dy = e.clientY - s.baseY
      const d = Math.hypot(dx, dy)
      if (d > STICK_R) {
        dx = (dx / d) * STICK_R
        dy = (dy / d) * STICK_R
      }
      touchInput.moveX = dx / STICK_R
      touchInput.moveY = dy / STICK_R
      return { ...s, dx, dy }
    })
  }
  const onMoveUp = (e) => {
    if (e.pointerId !== moveId.current) return
    moveId.current = null
    setStick(null)
    touchInput.active = false
    touchInput.moveX = 0
    touchInput.moveY = 0
  }

  const onLookDown = (e) => {
    if (lookId.current !== null) return
    e.preventDefault()
    lookId.current = e.pointerId
    e.currentTarget.setPointerCapture(e.pointerId)
    look.current = { x: e.clientX, y: e.clientY, moved: 0, t: performance.now() }
  }
  const onLookMove = (e) => {
    if (e.pointerId !== lookId.current) return
    const dx = e.clientX - look.current.x
    const dy = e.clientY - look.current.y
    look.current.x = e.clientX
    look.current.y = e.clientY
    look.current.moved += Math.abs(dx) + Math.abs(dy)
    touchInput.lookDX += dx
    touchInput.lookDY += dy
  }
  const onLookUp = (e) => {
    if (e.pointerId !== lookId.current) return
    lookId.current = null
    // a short, still tap on the world = interact (open the aimed door, etc.)
    if (look.current.moved < 10 && performance.now() - look.current.t < 350) {
      window.dispatchEvent(new Event('stride:interact'))
    }
  }

  return (
    <div className="touch-controls">
      <div
        className="touch-zone left"
        onPointerDown={onMoveDown}
        onPointerMove={onMovePointer}
        onPointerUp={onMoveUp}
        onPointerCancel={onMoveUp}
      >
        {stick && (
          <div
            className="stick-base"
            style={{ left: stick.baseX, top: stick.baseY }}
          >
            <div
              className="stick-knob"
              style={{ transform: `translate(${stick.dx}px, ${stick.dy}px)` }}
            />
          </div>
        )}
      </div>
      <div
        className="touch-zone right"
        onPointerDown={onLookDown}
        onPointerMove={onLookMove}
        onPointerUp={onLookUp}
        onPointerCancel={onLookUp}
      />
    </div>
  )
}
