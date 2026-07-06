import { useCallback, useEffect, useRef, useState } from 'react'
import { useStride } from '../store.js'
import { analyzeUpload } from '../lib/analyzeClient.js'
import { SAMPLES } from '../data/samples.js'
import { audio } from '../lib/audio.js'

function fmtDistance(m) {
  return m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(2)} km`
}

export default function Landing() {
  const phase = useStride((s) => s.phase)
  const error = useStride((s) => s.error)
  const analysisStatus = useStride((s) => s.analysisStatus)
  const lastWalk = useStride((s) => s.lastWalk)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef()
  const bannerRef = useRef()
  const samplesRef = useRef()
  const abortRef = useRef(null)

  // A failed upload must never fail silently below the fold
  useEffect(() => {
    if (error && bannerRef.current) {
      bannerRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [error])

  const handleFile = useCallback(async (file) => {
    if (!file) return
    const st = useStride.getState()
    if (!file.type.startsWith('image/')) {
      st.setError('That file isn’t an image. Export your plan as PNG, JPG, WebP or SVG and try again.')
      return
    }
    audio.init()
    audio.uiConfirm()
    st.startAnalyzing()
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const { plan, preview } = await analyzeUpload(file, st.setAnalysisStatus, controller.signal)
      st.enterWalkthrough(plan, preview)
    } catch (err) {
      if (err.name === 'AbortError') {
        useStride.setState({ phase: 'landing', error: null })
        return
      }
      audio.uiError()
      useStride.setState({ phase: 'landing', error: err.message })
    } finally {
      abortRef.current = null
    }
  }, [])

  const openSample = useCallback((sample) => {
    audio.init()
    audio.uiConfirm()
    useStride.getState().enterWalkthrough(sample.build(), sample.image)
  }, [])

  if (phase === 'analyzing') {
    return (
      <div className="landing">
        <div className="analyzing">
          <div className="scan-card">
            <div className="scan-grid">
              {Array.from({ length: 9 }, (_, i) => (
                <span key={i} style={{ animationDelay: `${i * 0.12}s` }} />
              ))}
            </div>
          </div>
          <h2>Reading your plan</h2>
          <p className="status">{analysisStatus}</p>
          <p className="fine">Stride is tracing walls, doors, rooms and scale — usually 20–60 seconds.</p>
          <button
            className="cancel-btn"
            onClick={() => { audio.uiClick(); abortRef.current?.abort() }}
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="landing">
      <header className="brand">
        <div className="mark">STRIDE</div>
        <div className="tagline">Upload any plan. Walk it before it exists.</div>
      </header>

      <main className="landing-main">
        {lastWalk && (
          <div className="walk-summary">
            <span>
              You walked <b>{lastWalk.steps.toLocaleString('en-US')} steps</b> ·{' '}
              {fmtDistance(lastWalk.distanceM)} through {lastWalk.name}
            </span>
            <button
              aria-label="Dismiss"
              onClick={() => useStride.getState().dismissLastWalk()}
            >
              ✕
            </button>
          </div>
        )}

        <div
          className={`dropzone${dragOver ? ' over' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            handleFile(e.dataTransfer.files?.[0])
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          <div className="dz-icon" aria-hidden>
            <svg viewBox="0 0 48 48" width="38" height="38" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="6" y="6" width="36" height="36" rx="3" />
              <path d="M6 20h14v10h12v12" />
              <path d="M28 6v8M20 30v12" opacity="0.5" />
            </svg>
          </div>
          <div className="dz-title">Drop your plan here</div>
          <div className="dz-sub">
            Site, land, floor or office plan — image formats.
            Stride detects what it is and builds the world.
          </div>
          <button className="dz-btn" type="button">Choose a file</button>
          <div className="dz-more" onClick={(e) => {
            e.stopPropagation()
            samplesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }}>
            No plan handy? Ready-made samples below ↓
          </div>
        </div>

        {error && (
          <div className="error-banner" ref={bannerRef}>
            <div className="error-head">Stride couldn’t analyze this plan.</div>
            <div className="error-detail">{error}</div>
            <button
              className="error-cta"
              onClick={() => samplesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              Try a sample instead →
            </button>
          </div>
        )}

        <div className="samples" ref={samplesRef}>
          <div className="samples-head">
            <span>Or step into a sample</span>
            <span className="fine">loads instantly</span>
          </div>
          <div className="sample-row">
            {SAMPLES.map((s) => (
              <button key={s.id} className="sample-card" onClick={() => openSample(s)}>
                <div className="sample-img" style={{ backgroundImage: `url(${s.image})` }} />
                <div className="sample-label">{s.label}</div>
                <div className="sample-caption">{s.caption}</div>
              </button>
            ))}
          </div>
        </div>
      </main>

      <footer className="landing-foot">
        Your plan is only used to build your 3D walkthrough.
      </footer>
    </div>
  )
}
