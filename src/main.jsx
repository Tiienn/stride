import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { useStride } from './store.js'
import './styles.css'

if (import.meta.env.DEV) window.__stride = useStride

createRoot(document.getElementById('root')).render(<App />)
