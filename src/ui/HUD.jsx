import { useEffect, useState } from 'react'
import { useStride } from '../store.js'
import { audio } from '../lib/audio.js'
import { isTouchDevice } from '../lib/touch.js'
import Minimap from './Minimap.jsx'
import TouchControls from './TouchControls.jsx'

function fmtDistance(m) {
  const ft = m * 3.28084
  return m < 1000 ? `${m.toFixed(0)} m · ${ft.toFixed(0)} ft` : `${(m / 1000).toFixed(2)} km`
}

function hourLabel(h) {
  const hh = Math.floor(h)
  const mm = Math.round((h - hh) * 60)
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

function boundarySteps(plan) {
  if (plan.planType !== 'site' || !plan.site?.boundary?.length) return null
  const poly = plan.site.boundary
  let perimeter = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    perimeter += Math.hypot(b.x - a.x, b.z - a.z)
  }
  return Math.round(perimeter / 0.75 / 10) * 10 // ~0.75 m per step, rounded
}

// Controls legend — context-aware: a land parcel has no doors or switches.
function Legend({ plan, touch }) {
  if (touch) {
    return (
      <div className="legend">
        <span><b>left thumb</b> move</span>
        <span><b>right thumb</b> look</span>
        <span><b>tap</b> {plan.planType === 'site' ? 'interact' : 'doors & switches'}</span>
      </div>
    )
  }
  return (
    <div className="legend">
      <span><b>W A S D</b> move</span>
      <span><b>mouse</b> look</span>
      <span><b>shift</b> run</span>
      <span><b>space</b> jump</span>
      {plan.planType !== 'site' && <span><b>E / click</b> doors & switches</span>}
      {plan.planType === 'site' && <span><b>walk</b> the boundary to feel the size</span>}
      <span><b>esc</b> settings & cursor</span>
    </div>
  )
}

export default function HUD() {
  const plan = useStride((s) => s.plan)
  const planPreview = useStride((s) => s.planPreview)
  const worldReady = useStride((s) => s.worldReady)
  const steps = useStride((s) => s.steps)
  const distanceM = useStride((s) => s.distanceM)
  const currentRoomId = useStride((s) => s.currentRoomId)
  const locked = useStride((s) => s.pointerLocked)
  const lookMode = useStride((s) => s.lookMode)
  const hint = useStride((s) => s.interactHint)
  const notice = useStride((s) => s.notice)
  const timeOfDay = useStride((s) => s.timeOfDay)
  const audioEnabled = useStride((s) => s.audioEnabled)
  const quality = useStride((s) => s.quality)
  const autoDegraded = useStride((s) => s.autoDegraded)
  const hasWalked = useStride((s) => s.hasWalked)
  const touch = isTouchDevice()

  useEffect(() => {
    audio.setEnabled(audioEnabled)
  }, [audioEnabled])

  // Auto-degrade toast shows briefly, then gets out of the way
  const [showToast, setShowToast] = useState(false)
  useEffect(() => {
    if (!autoDegraded) return
    setShowToast(true)
    const t = setTimeout(() => setShowToast(false), 6000)
    return () => clearTimeout(t)
  }, [autoDegraded, quality])

  // Transient notices (e.g. drag-look fallback engaged)
  const [showNotice, setShowNotice] = useState(null)
  useEffect(() => {
    if (!notice) return
    setShowNotice(notice)
    const t = setTimeout(() => {
      setShowNotice(null)
      useStride.getState().setNotice(null)
    }, 5000)
    return () => clearTimeout(t)
  }, [notice])

  // Browsers reject pointer-lock re-requests for ~1.3s after Esc. Holding
  // Resume disabled through that window prevents the rejected request from
  // being mistaken for "pointer lock unsupported".
  const [relockWait, setRelockWait] = useState(false)
  useEffect(() => {
    if (locked || !hasWalked || lookMode !== 'lock') return
    setRelockWait(true)
    const t = setTimeout(() => setRelockWait(false), 1450)
    return () => clearTimeout(t)
  }, [locked, hasWalked, lookMode])

  // Loading veil: keep mounted briefly after ready so the fade-out plays
  const [veilGone, setVeilGone] = useState(false)
  useEffect(() => {
    if (!worldReady) {
      setVeilGone(false)
      return
    }
    const t = setTimeout(() => setVeilGone(true), 700)
    return () => clearTimeout(t)
  }, [worldReady])

  // Re-openable controls help
  const [showHelp, setShowHelp] = useState(false)
  useEffect(() => {
    if (locked) setShowHelp(false)
  }, [locked])

  // A long walk shouldn't end on a misclick: past 100 steps, "New plan"
  // arms into a confirm state for a moment instead of exiting instantly.
  const [exitArmed, setExitArmed] = useState(false)
  useEffect(() => {
    if (!exitArmed) return
    const t = setTimeout(() => setExitArmed(false), 3000)
    return () => clearTimeout(t)
  }, [exitArmed])

  if (!plan) return null
  const room = plan.rooms.find((r) => r.id === currentRoomId)
  const st = useStride.getState()
  const stepsGoal = boundarySteps(plan)

  const enterWalk = () => {
    audio.init()
    audio.uiConfirm()
    window.dispatchEvent(new Event('stride:lock'))
  }
  // Click anywhere on the world (not a HUD control) to resume walking. Ignored
  // during the brief post-Esc window where a re-lock request would be rejected.
  const resume = () => {
    if (relockWait || useStride.getState().pointerLocked) return
    audio.init()
    audio.uiClick()
    window.dispatchEvent(new Event('stride:lock'))
  }

  return (
    <div className="hud">
      {/* Click-anywhere-to-resume catcher — sits behind every HUD card, so
          the top bar and minimap stay independently clickable while paused */}
      {!locked && hasWalked && <div className="tap-catcher" onClick={resume} />}

      {/* top bar */}
      <div className="hud-top">
        <div className="hud-card hud-place">
          <div className="hud-plan">{plan.name}</div>
          <div className="hud-room">
            {room
              ? `${room.name} · ${room.area.toFixed(0)} m²`
              : plan.planType === 'site'
                ? `${Math.round(plan.site.areaM2).toLocaleString('en-US')} m² parcel`
                : 'Outside'}
          </div>
        </div>

        <div className="hud-card hud-controls" onMouseDown={(e) => e.stopPropagation()}>
          <label className="tod">
            <span className="tod-icon">{timeOfDay > 6.2 && timeOfDay < 19.8 ? '☀' : '☾'}</span>
            <input
              type="range"
              min="0"
              max="24"
              step="0.25"
              value={timeOfDay}
              onChange={(e) => st.setTimeOfDay(parseFloat(e.target.value))}
            />
            <span className="tod-time">{hourLabel(timeOfDay)}</span>
          </label>
          <button
            className={`chip${audioEnabled ? ' on' : ''}`}
            onClick={() => { st.setAudioEnabled(!audioEnabled); audio.uiClick() }}
            title="Sound"
          >
            {audioEnabled ? '♪ on' : '♪ off'}
          </button>
          <select
            className="chip"
            value={quality}
            onChange={(e) => st.setQuality(e.target.value)}
            title="Render quality"
          >
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <button
            className="chip"
            title="Controls"
            onClick={() => { audio.uiClick(); setShowHelp((v) => !v) }}
          >
            ?
          </button>
          <button
            className={`chip exit${exitArmed ? ' armed' : ''}`}
            onClick={() => {
              audio.uiClick()
              // read live state — the closure could be a frame stale
              if (useStride.getState().steps > 100 && !exitArmed) {
                setExitArmed(true)
                return
              }
              st.backToLanding()
            }}
          >
            {exitArmed ? 'Leave walk?' : '✕ New plan'}
          </button>
        </div>
      </div>

      {/* whisper: the one fact that unlocks the whole settings loop */}
      {locked && !touch && <div className="esc-hint">esc — settings & cursor</div>}

      {showToast && (
        <div className="toast">Quality lowered to keep the walk smooth — override it top-right.</div>
      )}
      {showNotice && <div className="toast">{showNotice}</div>}

      {/* crosshair + interaction */}
      {locked && <div className={`crosshair${hint ? ' active' : ''}`} />}
      {locked && hint && (
        <button
          className="interact-hint"
          onClick={() => window.dispatchEvent(new Event('stride:interact'))}
        >
          {hint.label} — {touch ? <b>tap</b> : <><b>E</b> or click</>}
        </button>
      )}

      {/* foot count */}
      <div className="hud-bottom">
        <div className="hud-card steps-pill">
          <span className="steps-count">{steps.toLocaleString('en-US')}</span> steps
          <span className="dot">·</span>
          {fmtDistance(distanceM)}
          {stepsGoal && (
            <div className="steps-goal">walk the boundary — most take ~{stepsGoal} steps</div>
          )}
        </div>
      </div>

      {/* minimap */}
      <Minimap />

      {/* touch controls */}
      {locked && touch && <TouchControls />}

      {/* first entry: full overlay with the controls legend — click anywhere */}
      {!locked && !hasWalked && (
        <div className="enter-overlay" onClick={enterWalk}>
          <button className="enter-btn" onClick={(e) => { e.stopPropagation(); enterWalk() }}>
            {touch ? 'Tap to walk' : 'Click to walk'}
          </button>
          <Legend plan={plan} touch={touch} />
        </div>
      )}

      {/* after that, pausing keeps the HUD usable with a visible cursor */}
      {!locked && hasWalked && (
        <div className="resume-bar">
          <button
            className={`resume-btn${relockWait ? ' waiting' : ''}`}
            disabled={relockWait}
            onClick={() => { audio.init(); audio.uiClick(); window.dispatchEvent(new Event('stride:lock')) }}
          >
            ▶ Resume walking
          </button>
          <span className="resume-hint">or click anywhere to resume · settings above</span>
        </div>
      )}

      {/* re-opened controls help */}
      {showHelp && !locked && (
        <div className="enter-overlay help" onClick={() => setShowHelp(false)}>
          <div className="help-card hud-card" onClick={(e) => e.stopPropagation()}>
            <div className="help-title">Controls</div>
            <Legend plan={plan} touch={touch} />
            <button className="chip" onClick={() => setShowHelp(false)}>Close</button>
          </div>
        </div>
      )}

      {/* loading veil — never show a black void */}
      {!veilGone && (
        <div className={`world-veil${worldReady ? ' ready' : ''}`}>
          {planPreview && (
            <div className="veil-plan" style={{ backgroundImage: `url(${planPreview})` }} />
          )}
          <div className="veil-inner">
            <div className="veil-spinner" />
            <div className="veil-title">Building your world…</div>
            <div className="veil-sub">{plan.name}</div>
          </div>
        </div>
      )}
    </div>
  )
}
