import { useStride } from './store.js'
import Landing from './ui/Landing.jsx'
import HUD from './ui/HUD.jsx'
import Experience from './scene/Experience.jsx'

export default function App() {
  const phase = useStride((s) => s.phase)
  return (
    <>
      {phase === 'walkthrough' ? (
        <div className="stage">
          <Experience />
          <HUD />
        </div>
      ) : (
        <Landing />
      )}
    </>
  )
}
