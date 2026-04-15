import { useState, useRef, useEffect, useCallback } from 'react'
import * as Tone from 'tone'
import { PitchDetector } from 'pitchy'
import { WaveformCanvas }  from './components/WaveformCanvas'
import { SegmentEditor }   from './components/SegmentEditor'
import { TracksSection }   from './components/TracksSection'
import { CropExport }      from './components/CropExport'
import { buildStaticWaveform } from './utils/audioUtils'
import './App.css'

// ─── Autotune helper ─────────────────────────────────────────────────────────
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
function freqToNoteName(freq) {
  const midi = Math.round(69 + 12 * Math.log2(freq / 440))
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1)
}

// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  // ── Recording ──────────────────────────────────────────────────────────
  const [isRecording,   setIsRecording]   = useState(false)
  const [audioBlob,     setAudioBlob]     = useState(null)
  const [audioBuffer,   setAudioBuffer]   = useState(null)   // decoded AudioBuffer
  const [waveformData,  setWaveformData]  = useState(null)   // peak data for editors

  // ── Segments (pitch regions) ───────────────────────────────────────────
  // Each: { id, startTime, endTime, pitchShift, color }
  const [segments, setSegments] = useState([])

  // ── Playback ───────────────────────────────────────────────────────────
  const [isPlaying,   setIsPlaying]   = useState(false)
  const [isLoaded,    setIsLoaded]    = useState(false)
  const [currentTime, setCurrentTime] = useState(0)

  // ── Voice effects ──────────────────────────────────────────────────────
  const [pitch,       setPitch]       = useState(0)
  const [bass,        setBass]        = useState(0)
  const [treble,      setTreble]      = useState(0)
  const [autotuneOn,  setAutotuneOn]  = useState(false)
  const [detectedNote,setDetectedNote]= useState('')
  const [finnMode,    setFinnMode]    = useState(false)

  // ── Crop ───────────────────────────────────────────────────────────────
  const [crop, setCrop] = useState({ start: 0, end: 1 })

  // ─── Refs ──────────────────────────────────────────────────────────────
  // Recording
  const recAnalyserRef = useRef(null)
  const recCtxRef      = useRef(null)
  const mediaRecRef    = useRef(null)
  const streamRef      = useRef(null)
  const chunksRef      = useRef([])

  // Tone.js chain
  const playerRef       = useRef(null)
  const pitchShiftRef   = useRef(null)
  const eq3Ref          = useRef(null)
  const toneAnalyserRef = useRef(null)
  const blobUrlRef      = useRef(null)

  // Playback timing
  const playbackStartRef  = useRef(null)  // Tone.now() when player started
  const cropStartSecRef   = useRef(0)

  // Mirrors for rAF closures
  const pitchRef    = useRef(pitch)
  const segmentsRef = useRef(segments)
  const autotuneRef = useRef(autotuneOn)
  useEffect(() => { pitchRef.current    = pitch },      [pitch])
  useEffect(() => { segmentsRef.current = segments },   [segments])
  useEffect(() => { autotuneRef.current = autotuneOn }, [autotuneOn])

  // ── Parallax background ───────────────────────────────────────────────
  useEffect(() => {
    const onScroll = () => {
      document.body.style.backgroundPositionY = `${window.scrollY * 0.35}px`
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Autotune (playback)
  const detectorRef   = useRef(null)
  const correctionRef = useRef(0)

  // Finn Party Mode
  const finnUserMediaRef   = useRef(null)  // raw MediaStream (getUserMedia)
  const finnAnalyserRef    = useRef(null)  // Tone.Analyser — pitch detection tap
  const finnPs1Ref         = useRef(null)  // Tone.PitchShift
  const finnPs2Ref         = useRef(null)  // (unused — reserved)
  const finnPs3Ref         = useRef(null)  // (unused — reserved)
  const finnReverbRef      = useRef(null)  // Tone.Filter (HPF) — reused slot
  const finnBitcrusherRef  = useRef(null)  // Tone.BitCrusher — lo-fi grit
  const finnGainRef        = useRef(null)  // Tone.Gain (wet gate: 0=off, 1=on)
  const finnRecDestRef     = useRef(null)  // MediaStreamDestinationNode — for recording
  const finnDetectorRef    = useRef(null)  // pitchy PitchDetector
  const finnRafRef         = useRef(null)  // rAF loop id
  const finnModeRef        = useRef(false) // mirror of finnMode for callbacks
  useEffect(() => { finnModeRef.current = finnMode }, [finnMode])

  // Tracks
  const tracksSectionRef = useRef(null)
  const playRafRef       = useRef(null)

  // ══════════════════════════════════════════════════════════════════════════
  // RECORDING
  // ══════════════════════════════════════════════════════════════════════════
  const startRecording = async () => {
    try {
      let stream

      if (finnModeRef.current && finnRecDestRef.current) {
        // ── Finn Party Mode recording ──────────────────────────────────────
        // Capture the already-processed Finn output (pitch-shifted, bit-crushed,
        // filtered) rather than the raw mic — records what you actually hear.
        stream = finnRecDestRef.current.stream
        // Don't mute finn gain — user needs to hear themselves to perform
      } else {
        // ── Normal recording ───────────────────────────────────────────────
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        streamRef.current = stream
        // Silence finn monitoring to prevent feedback with a second open mic
        if (finnGainRef.current) finnGainRef.current.gain.value = 0
      }

      // Tap stream into an analyser for the live waveform display
      const ctx = new AudioContext()
      recCtxRef.current = ctx
      const src     = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      src.connect(analyser)
      recAnalyserRef.current = analyser

      const rec = new MediaRecorder(stream)
      mediaRecRef.current = rec
      chunksRef.current   = []

      rec.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }

      rec.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        setAudioBlob(blob)
        setSegments([])
        setCrop({ start: 0, end: 1 })
        recAnalyserRef.current = null
        recCtxRef.current?.close()

        // Decode for static waveform + editor
        const ab  = await blob.arrayBuffer()
        const ac  = new AudioContext()
        const buf = await ac.decodeAudioData(ab)
        ac.close()
        setAudioBuffer(buf)
        setWaveformData(buildStaticWaveform(buf))
      }

      rec.start(100)
      setIsRecording(true)
    } catch (err) {
      alert('Microphone access denied.\n' + err.message)
    }
  }

  const stopRecording = () => {
    if (mediaRecRef.current?.state !== 'inactive') mediaRecRef.current?.stop()
    // Only stop mic tracks for normal recording — Finn's stream belongs to its chain
    if (!finnModeRef.current) {
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
    setIsRecording(false)
    // Restore finn monitoring if it was muted for normal recording
    if (finnModeRef.current && finnGainRef.current) finnGainRef.current.gain.value = 1
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TONE.JS CHAIN — rebuild when blob changes
  // ══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!audioBlob) return

    playerRef.current?.dispose()
    pitchShiftRef.current?.dispose()
    eq3Ref.current?.dispose()
    toneAnalyserRef.current?.dispose()
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)

    setIsLoaded(false)
    setIsPlaying(false)
    correctionRef.current = 0

    const url = URL.createObjectURL(audioBlob)
    blobUrlRef.current = url

    const ps       = new Tone.PitchShift(0)
    const eq       = new Tone.EQ3({ low: 0, mid: 0, high: 0 })
    const analyser = new Tone.Analyser('waveform', 2048)

    pitchShiftRef.current   = ps
    eq3Ref.current          = eq
    toneAnalyserRef.current = analyser

    const player = new Tone.Player({
      url,
      onload: () => setIsLoaded(true),
      onstop: () => { setIsPlaying(false); setCurrentTime(0) },
    })
    player.chain(ps, eq, analyser, Tone.getDestination())
    playerRef.current = player
  }, [audioBlob])

  // Sync global effects → Tone nodes
  useEffect(() => {
    if (!autotuneOn && pitchShiftRef.current) pitchShiftRef.current.pitch = pitch
  }, [pitch, autotuneOn])
  useEffect(() => { if (eq3Ref.current) eq3Ref.current.low.value  = bass   }, [bass])
  useEffect(() => { if (eq3Ref.current) eq3Ref.current.high.value = treble }, [treble])

  // ══════════════════════════════════════════════════════════════════════════
  // PLAYBACK
  // ══════════════════════════════════════════════════════════════════════════
  const handlePlay = async () => {
    if (!playerRef.current || !isLoaded) return
    await Tone.start()

    const startAt      = Tone.now() + 0.05
    const cropStartSec = crop.start * (audioBuffer?.duration ?? 0)
    cropStartSecRef.current  = cropStartSec
    playbackStartRef.current = startAt

    playerRef.current.start(startAt, cropStartSec)
    tracksSectionRef.current?.startAll(startAt)
    setIsPlaying(true)
  }

  const handleStop = useCallback(() => {
    playerRef.current?.stop()
    tracksSectionRef.current?.stopAll()
    setIsPlaying(false)
    setCurrentTime(0)
    if (pitchShiftRef.current) pitchShiftRef.current.pitch = pitchRef.current
  }, [])

  // ── Unified playback rAF loop ──────────────────────────────────────────
  // Applies per-segment pitch shift OR autotune each frame.
  useEffect(() => {
    if (!isPlaying) {
      cancelAnimationFrame(playRafRef.current)
      if (!autotuneRef.current) setDetectedNote('')
      return
    }

    if (!detectorRef.current) {
      detectorRef.current = PitchDetector.forFloat32Array(2048)
    }
    const sampleRate = Tone.getContext().sampleRate

    const tick = () => {
      // Current voice position in the source audio
      const voicePos = cropStartSecRef.current + (Tone.now() - playbackStartRef.current)
      setCurrentTime(voicePos)

      if (autotuneRef.current) {
        // Real-time pitch snap to nearest semitone
        const data = toneAnalyserRef.current?.getValue()
        if (data) {
          const [freq, clarity] = detectorRef.current.findPitch(data, sampleRate)
          if (clarity > 0.8 && freq > 60 && freq < 1600) {
            const semiF   = 12 * Math.log2(freq / 440)
            const nearest = Math.round(semiF)
            correctionRef.current += (nearest - semiF - correctionRef.current) * 0.12
            if (pitchShiftRef.current)
              pitchShiftRef.current.pitch = pitchRef.current + correctionRef.current
            setDetectedNote(freqToNoteName(freq))
          }
        }
      } else {
        // Per-segment pitch from SegmentEditor
        const seg = segmentsRef.current.find(
          s => s.startTime <= voicePos && s.endTime > voicePos
        )
        const correction = seg ? seg.pitchShift : 0
        if (pitchShiftRef.current)
          pitchShiftRef.current.pitch = pitchRef.current + correction
      }

      playRafRef.current = requestAnimationFrame(tick)
    }

    playRafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(playRafRef.current)
  }, [isPlaying])

  // ══════════════════════════════════════════════════════════════════════════
  // FINN PARTY MODE — live mic hard-autotune
  // Uses Tone.UserMedia so the whole chain is Tone-native (no raw AudioNode
  // bridging that silently drops the signal).
  // Chain: UserMedia ──► Analyser (detection tap, no output)
  //                 └──► PitchShift ──► Gain (wet) ──► Destination
  // ══════════════════════════════════════════════════════════════════════════
  const toggleFinnMode = async () => {
    await Tone.start()

    if (finnModeRef.current) {
      // ── Turn off ──────────────────────────────────────────────────────
      cancelAnimationFrame(finnRafRef.current)
      if (finnGainRef.current) finnGainRef.current.gain.value = 0
      setFinnMode(false)
      return
    }

    // ── Build chain once; reuse on subsequent toggles ─────────────────────
    if (!finnUserMediaRef.current) {
      try {
        // Request mic with ALL browser processing disabled from the very start
        // (applyConstraints after open() is too late — AGC may already be running)
        const rawStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          }
        })
        finnUserMediaRef.current = rawStream   // MediaStream — stop tracks to cleanup

        // Bridge raw MediaStreamSource → Tone.js via Tone.Gain.input (native GainNode)
        // This avoids the silent-drop that happens when connecting a raw AudioNode
        // directly to a Tone AudioNode (which wraps a different internal graph).
        const rawCtx = Tone.getContext().rawContext
        const rawSrc = rawCtx.createMediaStreamSource(rawStream)

        const bridge = new Tone.Gain(1.0)
        rawSrc.connect(bridge.input)   // native → native GainNode ✓

        // Detection tap — waveform analyser for pitchy
        const analyser = new Tone.Analyser('waveform', 2048)
        finnAnalyserRef.current = analyser

        // windowSize 0.03s = tiny grains → fastest possible pitch response
        // Smaller = more instantaneous transitions, larger = smoother but sluggish
        const ps1 = new Tone.PitchShift({ pitch: 0, windowSize: 0.03 })
        finnPs1Ref.current = ps1

        // BitCrusher(4) — 4-bit depth quantization, adds 8-bit digital grit
        // Gives the "Finn's stomach computer" lo-fi crunchy character
        const crusher = new Tone.BitCrusher(4)
        finnBitcrusherRef.current = crusher

        // High-pass filter at 150 Hz — cuts low rumble, robot speaker timbre
        const hpf = new Tone.Filter(150, 'highpass')
        finnReverbRef.current = hpf   // reuse unused ref slot

        // Heavy makeup gain + master wet gate
        const makeup = new Tone.Gain(8.0)
        const wet    = new Tone.Gain(0)
        finnGainRef.current = wet

        // MediaStreamDestinationNode — tap processed audio for recording
        const recDest = Tone.getContext().rawContext.createMediaStreamDestination()
        finnRecDestRef.current = recDest

        bridge.connect(analyser)   // pitch detection tap
        bridge.connect(ps1)
        ps1.connect(crusher)
        crusher.connect(hpf)
        hpf.connect(makeup)
        makeup.connect(wet)
        wet.toDestination()
        wet.connect(recDest)       // also feed recording output

        finnDetectorRef.current = PitchDetector.forFloat32Array(2048)
      } catch (err) {
        alert('Microphone access denied for Finn Party Mode.\n' + err.message)
        return
      }
    }

    // Mute during recording to prevent feedback; restored in stopRecording
    if (!isRecording) finnGainRef.current.gain.value = 1
    setFinnMode(true)

    // ── Discrete-step pitch quantization ─────────────────────────────────
    // Key insight: Tone.PitchShift cross-fades its internal grain buffers,
    // so continuously updating pitch every frame causes smooth slides even
    // with "instant" assignment. The fix: treat notes as discrete blocks —
    // only fire a pitch change when the note has genuinely changed AND a
    // minimum block duration has elapsed. The shifter's buffers never see
    // a mid-frame drift — every update is a clean jump to a new value.

    const sr            = Tone.getContext().sampleRate
    const PENTA         = [0, 2, 4, 7, 9]  // C major pentatonic note classes (0=C)
    const MIN_BLOCK_MS  = 80               // minimum ms between note changes

    let lastSnappedMidi = null
    let lastChangeTime  = 0

    const loop = () => {
      const now  = performance.now()
      const raw  = finnAnalyserRef.current.getValue()
      const data = raw instanceof Float32Array ? raw : raw[0]
      const [freq, clarity] = finnDetectorRef.current.findPitch(data, sr)

      if (clarity > 0.8 && freq > 50 && freq < 1200) {
        const detectedMidi = 12 * Math.log2(freq / 440) + 69

        // Snap to nearest C major pentatonic degree in MIDI space
        const roundedMidi  = Math.round(detectedMidi)
        const noteClass    = ((roundedMidi % 12) + 12) % 12  // 0=C … 11=B, always +ve
        const octaveBase   = roundedMidi - noteClass

        let snappedClass = PENTA.reduce((best, n) =>
          Math.abs(n - noteClass) < Math.abs(best - noteClass) ? n : best
        )
        // Check if next-octave C is closer
        if (Math.abs(12 - noteClass) < Math.abs(snappedClass - noteClass)) snappedClass = 12

        const snappedMidi = octaveBase + snappedClass

        // Block gate: only update when note has CHANGED and MIN_BLOCK_MS elapsed.
        // This is what forces the chunky, discrete-step character.
        if (snappedMidi !== lastSnappedMidi && now - lastChangeTime > MIN_BLOCK_MS) {
          // Hard instantaneous assignment — never rampTo, never interpolate.
          finnPs1Ref.current.pitch = snappedMidi - detectedMidi
          lastSnappedMidi = snappedMidi
          lastChangeTime  = now
        }
      }

      finnRafRef.current = requestAnimationFrame(loop)
    }
    finnRafRef.current = requestAnimationFrame(loop)
  }

  // Cleanup finn chain on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(finnRafRef.current)
      // finnUserMediaRef now holds a raw MediaStream — stop its tracks
      finnUserMediaRef.current?.getTracks?.().forEach(t => t.stop())
      finnAnalyserRef.current?.dispose()
      finnPs1Ref.current?.dispose()
      finnBitcrusherRef.current?.dispose()
      finnReverbRef.current?.dispose()
      finnGainRef.current?.dispose()
    }
  }, [])

  // ── Live waveform data ─────────────────────────────────────────────────
  const getWaveformData = useCallback(() => {
    if (isRecording && recAnalyserRef.current) {
      const buf = new Float32Array(recAnalyserRef.current.fftSize)
      recAnalyserRef.current.getFloatTimeDomainData(buf)
      return buf
    }
    if (isPlaying && toneAnalyserRef.current) return toneAnalyserRef.current.getValue()
    return null
  }, [isRecording, isPlaying])

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════
  return (
    <div className="app">
      <header className="header">
        <h1>DJ Jellyfish</h1>
        <p>Multi-track voice recorder &amp; editor</p>
      </header>

      {/* Live waveform */}
      <div className="card waveform-card">
        <WaveformCanvas
          getWaveformData={getWaveformData}
          isActive={isRecording || isPlaying}
          color={isRecording ? '#ff4060' : '#00d4ff'}
        />
      </div>

      {/* Record + Playback */}
      <div className="card record-section">
        <button
          className={`record-btn ${isRecording ? 'recording' : ''}`}
          onClick={isRecording ? stopRecording : startRecording}
          disabled={isPlaying}
        >
          <div className="rec-icon" />
          <span className="rec-label">{isRecording ? 'Stop' : 'Record'}</span>
        </button>

        {audioBlob ? (
          <div className="playback-row">
            <button className="btn btn-play"
              onClick={handlePlay}
              disabled={!isLoaded || isPlaying || isRecording}>
              {isLoaded ? '▶  Play' : 'Loading…'}
            </button>
            <button className="btn btn-stop"
              onClick={handleStop}
              disabled={!isPlaying}>
              ■  Stop
            </button>
          </div>
        ) : (
          <p className="empty-hint">Hit record to get started</p>
        )}

        {/* Finn Party Mode — always visible, works on live mic */}
        <div className="finn-row">
          <button
            className={`finn-btn ${finnMode ? 'on' : ''}`}
            onClick={toggleFinnMode}
          >
            🎤 Finn Party Mode
          </button>
          <p className="finn-hint">
            {finnMode
              ? '🔵 Hard auto-tune active — speak or sing into your mic'
              : 'Real-time pitch snap to nearest semitone (use headphones)'}
          </p>
        </div>
      </div>

      {/* Multi-track mixer — always visible */}
      <TracksSection ref={tracksSectionRef} />

      {/* Post-recording sections */}
      {audioBlob && (
        <>
          {/* Segment pitch editor */}
          <div className="card">
            <p className="section-label">Pitch Regions</p>
            <SegmentEditor
              waveformData={waveformData}
              duration={audioBuffer?.duration ?? 1}
              audioBuffer={audioBuffer}
              segments={segments}
              onSegmentsChange={setSegments}
              currentTime={currentTime}
            />
          </div>

          {/* Voice effects */}
          <div className="card controls">
            <p className="section-label">Voice Effects</p>
            <SliderRow label="Pitch" unit="st"
              value={pitch} min={-12} max={12} step={0.5}
              sliderClass="pitch-slider" onChange={setPitch}
              format={v => (v > 0 ? '+' : '') + v}
            />
            <SliderRow label="Bass" unit="dB"
              value={bass} min={-12} max={12} step={1}
              sliderClass="bass-slider" onChange={setBass}
              format={v => (v > 0 ? '+' : '') + v}
            />
            <SliderRow label="Treble" unit="dB"
              value={treble} min={-12} max={12} step={1}
              sliderClass="treble-slider" onChange={setTreble}
              format={v => (v > 0 ? '+' : '') + v}
            />

            <div className="autotune-row">
              <div className="autotune-left">
                <div className="autotune-title">
                  <span className={`status-dot ${autotuneOn && isPlaying ? 'active' : ''}`} />
                  Auto-Tune
                </div>
                <p className="autotune-desc">Real-time snap to nearest musical note</p>
                {autotuneOn && detectedNote && (
                  <p className="detected-note">Detected: {detectedNote}</p>
                )}
              </div>
              <button
                className={`toggle-btn ${autotuneOn ? 'on' : ''}`}
                onClick={() => { setAutotuneOn(v => !v); setDetectedNote('') }}
              >
                {autotuneOn ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>

          {/* Crop + Export */}
          <CropExport
            audioBuffer={audioBuffer}
            waveformData={waveformData}
            segments={segments}
            pitch={pitch}
            bass={bass}
            treble={treble}
            tracksRef={tracksSectionRef}
            onCropChange={setCrop}
          />
        </>
      )}
    </div>
  )
}

// ─── Reusable slider row ──────────────────────────────────────────────────────
function SliderRow({ label, unit, value, min, max, step, sliderClass, onChange, format }) {
  return (
    <div className="control-row">
      <div className="ctrl-label">
        <strong>{label}</strong>
        <small>{unit}</small>
      </div>
      <div className="slider-track">
        <input type="range" className={sliderClass}
          min={min} max={max} step={step} value={value}
          onChange={e => onChange(Number(e.target.value))} />
      </div>
      <div className="ctrl-value">{format ? format(value) : value}</div>
    </div>
  )
}
