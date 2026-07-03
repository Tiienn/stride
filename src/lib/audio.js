// Stride's audio engine. Everything is synthesized in WebAudio — footsteps
// tuned per floor surface, environmental ambience, object and UI sounds —
// routed through a generated-impulse reverb whose size follows the space
// you're standing in. No audio assets, no licensing, instant load.

class AudioEngine {
  constructor() {
    this.ctx = null
    this.enabled = true
    this._ambience = null
  }

  // Must be called from a user gesture.
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume()
      return
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    this.ctx = ctx

    this.master = ctx.createGain()
    this.master.gain.value = 0.9
    this.master.connect(ctx.destination)

    // FX bus: dry + convolver wet in parallel
    this.fxDry = ctx.createGain()
    this.fxDry.gain.value = 1
    this.fxDry.connect(this.master)
    this.reverb = ctx.createConvolver()
    this.reverb.buffer = this._impulse(1.6, 3.5)
    this.fxWet = ctx.createGain()
    this.fxWet.gain.value = 0.12
    this.fxIn = ctx.createGain()
    this.fxIn.connect(this.fxDry)
    this.fxIn.connect(this.reverb)
    this.reverb.connect(this.fxWet)
    this.fxWet.connect(this.master)

    this.ambienceBus = ctx.createGain()
    this.ambienceBus.gain.value = 1
    this.ambienceBus.connect(this.master)

    this.uiBus = ctx.createGain()
    this.uiBus.gain.value = 0.5
    this.uiBus.connect(this.master)

    this._noise = this._makeNoise('white')
    this._pink = this._makeNoise('pink')
    this._brown = this._makeNoise('brown')
    this._startAmbience()
  }

  setEnabled(on) {
    this.enabled = on
    if (!this.ctx) return
    const t = this.ctx.currentTime
    this.master.gain.cancelScheduledValues(t)
    this.master.gain.linearRampToValueAtTime(on ? 0.9 : 0, t + 0.25)
  }

  // ---- environment control -------------------------------------------------

  // profile: 'home' | 'office' | 'exterior'; hour: 0-24; roomArea m²
  setEnvironment({ profile, hour, roomArea = 20 }) {
    this._env = { profile, hour, roomArea }
    if (!this.ctx) return
    const t = this.ctx.currentTime
    const day = hour > 6.5 && hour < 19.5 ? 1 : 0
    const a = this._ambience
    if (!a) return
    const ramp = (g, v) => {
      g.gain.cancelScheduledValues(t)
      g.gain.setTargetAtTime(v, t, 1.2)
    }
    const ext = profile === 'exterior'
    ramp(a.windGain, ext ? 0.055 : 0.006)
    ramp(a.birdGain, ext ? day * 0.16 : day * 0.02)
    ramp(a.cricketGain, ext ? (1 - day) * 0.06 : 0)
    ramp(a.roomGain, ext ? 0 : 0.02)
    ramp(a.hvacGain, profile === 'office' ? 0.022 : 0)
    // Reverb size follows the space
    const wet = ext ? 0.04 : Math.min(0.28, 0.08 + roomArea * 0.002)
    this.fxWet.gain.setTargetAtTime(wet, t, 0.8)
  }

  // ---- one-shots -----------------------------------------------------------

  footstep(surface, speed = 1) {
    if (!this.ready()) return
    const t = this.ctx.currentTime
    const vel = 0.75 + Math.random() * 0.25 * speed
    switch (surface) {
      case 'wood': {
        this._thump(t, 68 + Math.random() * 12, 0.09, 0.5 * vel)
        this._burst(t, { dur: 0.075, type: 'bandpass', freq: 320 + Math.random() * 140, q: 1.1, gain: 0.34 * vel })
        if (Math.random() < 0.05) this._creak(t + 0.02, 0.16, 0.05)
        break
      }
      case 'tile':
      case 'concrete': {
        this._thump(t, 85, 0.05, 0.28 * vel)
        this._burst(t, { dur: 0.045, type: 'bandpass', freq: 1500 + Math.random() * 600, q: 2.2, gain: 0.22 * vel })
        this._burst(t, { dur: 0.03, type: 'highpass', freq: 3200, q: 0.7, gain: 0.1 * vel })
        break
      }
      case 'carpet': {
        this._burst(t, { dur: 0.13, type: 'lowpass', freq: 420 + Math.random() * 120, q: 0.6, gain: 0.3 * vel })
        break
      }
      case 'grass': {
        for (let i = 0; i < 2; i++) {
          this._burst(t + i * 0.02, { dur: 0.05, type: 'bandpass', freq: 3300 + Math.random() * 1800, q: 0.9, gain: 0.14 * vel })
        }
        this._thump(t, 62, 0.06, 0.14 * vel)
        break
      }
      case 'gravel':
      case 'ground': {
        for (let i = 0; i < 4; i++) {
          this._burst(t + Math.random() * 0.05, { dur: 0.035, type: 'bandpass', freq: 1200 + Math.random() * 2600, q: 2.5, gain: 0.1 * vel })
        }
        this._thump(t, 70, 0.06, 0.18 * vel)
        break
      }
      default:
        this._burst(t, { dur: 0.07, type: 'bandpass', freq: 800, q: 1, gain: 0.25 * vel })
    }
  }

  doorOpen() {
    if (!this.ready()) return
    const t = this.ctx.currentTime
    this._creak(t, 0.5, 0.12)
    this._burst(t + 0.02, { dur: 0.06, type: 'bandpass', freq: 1900, q: 3, gain: 0.12 }) // latch
  }

  doorClose() {
    if (!this.ready()) return
    const t = this.ctx.currentTime
    this._thump(t, 55, 0.16, 0.5)
    this._burst(t, { dur: 0.05, type: 'lowpass', freq: 900, q: 0.8, gain: 0.3 })
    this._burst(t + 0.05, { dur: 0.04, type: 'bandpass', freq: 2400, q: 4, gain: 0.14 }) // latch snap
  }

  switchClick(on) {
    if (!this.ready()) return
    const t = this.ctx.currentTime
    this._burst(t, { dur: 0.018, type: 'bandpass', freq: on ? 2600 : 2100, q: 5, gain: 0.3, bus: 'ui' })
    this._burst(t + 0.03, { dur: 0.014, type: 'bandpass', freq: on ? 3400 : 1700, q: 5, gain: 0.18, bus: 'ui' })
  }

  uiClick() {
    if (!this.ready()) return
    this._blip(720, 0.05, 0.16)
  }
  uiConfirm() {
    if (!this.ready()) return
    this._blip(620, 0.06, 0.14)
    this._blip(930, 0.09, 0.12, 0.06)
  }
  uiError() {
    if (!this.ready()) return
    this._blip(300, 0.14, 0.16)
  }

  ready() {
    return !!this.ctx && this.enabled
  }

  // ---- synthesis internals ---------------------------------------------------

  _impulse(seconds, decay) {
    const rate = 44100
    const len = Math.floor(seconds * rate)
    const buf = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: rate })
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch)
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay)
      }
    }
    return buf
  }

  _makeNoise(kind) {
    const rate = 44100
    const len = rate * 2
    const buf = new AudioBuffer({ numberOfChannels: 1, length: len, sampleRate: rate })
    const d = buf.getChannelData(0)
    let b0 = 0, b1 = 0, b2 = 0, last = 0
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1
      if (kind === 'white') d[i] = w
      else if (kind === 'pink') {
        b0 = 0.99765 * b0 + w * 0.099046
        b1 = 0.963 * b1 + w * 0.2965164
        b2 = 0.57 * b2 + w * 1.0526913
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22
      } else {
        last = (last + 0.02 * w) / 1.02
        d[i] = last * 3.5
      }
    }
    return buf
  }

  _noiseSource(buffer) {
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.loop = true
    src.playbackRate.value = 0.85 + Math.random() * 0.3
    return src
  }

  _burst(t, { dur, type, freq, q, gain, bus = 'fx' }) {
    const ctx = this.ctx
    const src = this._noiseSource(this._noise)
    const filter = ctx.createBiquadFilter()
    filter.type = type
    filter.frequency.value = freq
    filter.Q.value = q
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(gain, t + 0.004)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    src.connect(filter).connect(g).connect(bus === 'ui' ? this.uiBus : this.fxIn)
    src.start(t)
    src.stop(t + dur + 0.05)
  }

  _thump(t, freq, dur, gain) {
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq * 1.6, t)
    osc.frequency.exponentialRampToValueAtTime(freq, t + dur * 0.5)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(gain, t + 0.006)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    osc.connect(g).connect(this.fxIn)
    osc.start(t)
    osc.stop(t + dur + 0.05)
  }

  _creak(t, dur, gain) {
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    const f0 = 110 + Math.random() * 60
    osc.frequency.setValueAtTime(f0, t)
    osc.frequency.linearRampToValueAtTime(f0 * (0.7 + Math.random() * 0.2), t + dur)
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = f0 * 6
    filter.Q.value = 9
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(gain, t + dur * 0.3)
    g.gain.linearRampToValueAtTime(0, t + dur)
    // amplitude flutter — the "grain" of a hinge
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 26 + Math.random() * 14
    const lfoG = ctx.createGain()
    lfoG.gain.value = gain * 0.5
    lfo.connect(lfoG).connect(g.gain)
    osc.connect(filter).connect(g).connect(this.fxIn)
    osc.start(t); lfo.start(t)
    osc.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05)
  }

  _blip(freq, dur, gain, delay = 0) {
    const ctx = this.ctx
    const t = ctx.currentTime + delay
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = freq
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(gain, t + 0.008)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    osc.connect(g).connect(this.uiBus)
    osc.start(t)
    osc.stop(t + dur + 0.05)
  }

  // ---- continuous ambience ----------------------------------------------------

  _startAmbience() {
    const ctx = this.ctx
    const a = {}

    // Wind: pink noise through a slowly wandering bandpass
    const wind = this._noiseSource(this._pink)
    const windF = ctx.createBiquadFilter()
    windF.type = 'bandpass'
    windF.frequency.value = 380
    windF.Q.value = 0.45
    const windLfo = ctx.createOscillator()
    windLfo.frequency.value = 0.07
    const windLfoG = ctx.createGain()
    windLfoG.gain.value = 190
    windLfo.connect(windLfoG).connect(windF.frequency)
    a.windGain = ctx.createGain()
    a.windGain.gain.value = 0
    wind.connect(windF).connect(a.windGain).connect(this.ambienceBus)
    wind.start(); windLfo.start()

    // Interior room tone: brown noise, heavily lowpassed
    const room = this._noiseSource(this._brown)
    const roomF = ctx.createBiquadFilter()
    roomF.type = 'lowpass'
    roomF.frequency.value = 170
    a.roomGain = ctx.createGain()
    a.roomGain.gain.value = 0
    room.connect(roomF).connect(a.roomGain).connect(this.ambienceBus)
    room.start()

    // HVAC: band of noise + faint 100 Hz electrical hum
    const hvac = this._noiseSource(this._pink)
    const hvacF = ctx.createBiquadFilter()
    hvacF.type = 'bandpass'
    hvacF.frequency.value = 480
    hvacF.Q.value = 0.8
    a.hvacGain = ctx.createGain()
    a.hvacGain.gain.value = 0
    hvac.connect(hvacF).connect(a.hvacGain).connect(this.ambienceBus)
    hvac.start()
    const hum = ctx.createOscillator()
    hum.frequency.value = 100
    const humG = ctx.createGain()
    humG.gain.value = 0.12
    hum.connect(humG).connect(a.hvacGain)
    hum.start()

    // Birds + crickets are scheduled grains, gated by their gains
    a.birdGain = ctx.createGain()
    a.birdGain.gain.value = 0
    a.birdGain.connect(this.ambienceBus)
    a.cricketGain = ctx.createGain()
    a.cricketGain.gain.value = 0
    a.cricketGain.connect(this.ambienceBus)

    this._ambience = a
    this._scheduleBirds()
    this._scheduleCrickets()
    if (this._env) this.setEnvironment(this._env)
  }

  _scheduleBirds() {
    if (!this.ctx) return
    const next = 1200 + Math.random() * 5200
    setTimeout(() => {
      if (this.ctx && this._ambience) this._birdCall()
      this._scheduleBirds()
    }, next)
  }

  _birdCall() {
    const ctx = this.ctx
    const t0 = ctx.currentTime + 0.05
    const pan = ctx.createStereoPanner()
    pan.pan.value = Math.random() * 1.6 - 0.8
    pan.connect(this._ambience.birdGain)
    const base = 2300 + Math.random() * 1700
    const chirps = 2 + Math.floor(Math.random() * 4)
    for (let i = 0; i < chirps; i++) {
      const t = t0 + i * (0.09 + Math.random() * 0.07)
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(base * (1 + Math.random() * 0.15), t)
      osc.frequency.exponentialRampToValueAtTime(base * (0.72 + Math.random() * 0.1), t + 0.06)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(0.5 + Math.random() * 0.4, t + 0.012)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.07)
      osc.connect(g).connect(pan)
      osc.start(t)
      osc.stop(t + 0.1)
    }
  }

  _scheduleCrickets() {
    if (!this.ctx) return
    setTimeout(() => {
      if (this.ctx && this._ambience) this._cricketBurst()
      this._scheduleCrickets()
    }, 400 + Math.random() * 900)
  }

  _cricketBurst() {
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = 4200 + Math.random() * 600
    const g = ctx.createGain()
    g.gain.value = 0
    const pulses = 5 + Math.floor(Math.random() * 5)
    for (let i = 0; i < pulses; i++) {
      const t = t0 + i * 0.055
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(0.5, t + 0.01)
      g.gain.linearRampToValueAtTime(0, t + 0.045)
    }
    const pan = ctx.createStereoPanner()
    pan.pan.value = Math.random() * 1.6 - 0.8
    osc.connect(g).connect(pan).connect(this._ambience.cricketGain)
    osc.start(t0)
    osc.stop(t0 + pulses * 0.06 + 0.1)
  }
}

export const audio = new AudioEngine()
