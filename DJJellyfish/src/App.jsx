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

  // Finn Party Mode — live mic pitch-quantizer chain (all Tone.js native)
  const finnUserMediaRef = useRef(null)   // Tone.UserMedia
  const finnAnalyserRef  = useRef(null)   // Tone.Analyser (waveform, for pitchy)
  const finnPsRef        = useRef(null)   // Tone.PitchShift
  const finnGainRef      = useRef(null)   // Tone.Gain (wet: 0=off, 1=on)
  const finnDetectorRef  = useRef(null)   // pitchy PitchDetector
  const finnRafRef       = useRef(null)   // rAF loop id
  const finnModeRef      = useRef(false)  // mirror of finnMode for callbacks
  useEffect(() => { finnModeRef.current = finnMode }, [finnMode])

  // Tracks
  const tracksSectionRef = useRef(null)
  const playRafRef       = useRef(null)

  // ══════════════════════════════════════════════════════════════════════════
  // RECORDING
  // ══════════════════════════════════════════════════════════════════════════
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const ctx     = new AudioContext()
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

        // Decode for static waveform display
        const ab  = await blob.arrayBuffer()
        const ac  = new AudioContext()
        const buf = await ac.decodeAudioData(ab)
        ac.close()
        setAudioBuffer(buf)
        setWaveformData(buildStaticWaveform(buf))
      }

      // Silence finn monitoring while recording to prevent feedback
      if (finnGainRef.current) finnGainRef.current.gain.value = 0

      rec.start(100)
      setIsRecording(true)
    } catch (err) {
      alert('Microphone access denied.\n' + err.message)
    }
  }

  const stopRecording = () => {
    if (mediaRecRef.current?.state !== 'inactive') mediaRecRef.current?.stop()
    streamRef.current?.getTracks().forEach(t => t.stop())
    setIsRecording(false)
    // Restore finn monitoring now that recording mic is closed
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
        const um = new Tone.UserMedia()
        await um.open()
        finnUserMediaRef.current = um

        // Waveform analyser for pitchy detection — purely a read tap, no output
        const analyser = new Tone.Analyser('waveform', 2048)
        finnAnalyserRef.current = analyser

        // windowSize 0.05s = shorter grains → more robotic phasing artifacts
        const ps  = new Tone.PitchShift({ pitch: 0, windowSize: 0.05 })
        const wet = new Tone.Gain(0)   // starts silent; set to 1 when active
        finnPsRef.current   = ps
        finnGainRef.current = wet

        // Pure Tone-to-Tone connections — no raw AudioNode bridging
        um.connect(analyser)   // detection tap (analyser has no downstream connection)
        um.connect(ps)         // processing path
        ps.connect(wet)
        wet.toDestination()

        finnDetectorRef.current = PitchDetector.forFloat32Array(2048)
      } catch (err) {
        alert('Microphone access denied for Finn Party Mode.\n' + err.message)
        return
      }
    }

    // Mute during recording to prevent feedback; restored in stopRecording
    if (!isRecording) finnGainRef.current.gain.value = 1
    setFinnMode(true)

    // ── Pitch quantization rAF loop ──────────────────────────────────────
    // Snaps detected pitch to C major pentatonic (0,2,4,7,9 semitones from C).
    // Gaps of 2-3 semitones mean corrections up to ~1.5st — clearly audible.
    // Holds last correction between low-clarity frames (no snap-back to 0).
    const PENTA = [0, 2, 4, 7, 9]

    const snapToPentatonic = (semiFromA4) => {
      const fromC  = semiFromA4 + 9       // A4 is 9st above C4
      const octave = Math.floor(fromC / 12)
      const pos    = fromC - octave * 12  // position within octave [0,12)

      let best = PENTA[0], bestDist = Math.abs(pos - PENTA[0])
      for (const n of PENTA) {
        const d = Math.abs(pos - n)
        if (d < bestDist) { bestDist = d; best = n }
      }
      if (Math.abs(pos - 12) < bestDist) best = 12   // check next-octave C

      const targetFromA4 = (octave * 12 + best) - 9
      return Math.max(-12, Math.min(12, targetFromA4 - semiFromA4))
    }

    const sr = Tone.getContext().sampleRate
    let lastShift = 0

    const loop = () => {
      const data = finnAnalyserRef.current.getValue()  // Float32Array via Tone.Analyser
      const [freq, clarity] = finnDetectorRef.current.findPitch(data, sr)
      if (clarity > 0.65 && freq > 60 && freq < 1200) {
        lastShift = snapToPentatonic(12 * Math.log2(freq / 440))
      }
      finnPsRef.current.pitch = lastShift   // hold between frames
      finnRafRef.current = requestAnimationFrame(loop)
    }
    finnRafRef.current = requestAnimationFrame(loop)
  }

  // Cleanup finn chain on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(finnRafRef.current)
      finnUserMediaRef.current?.close()
      finnAnalyserRef.current?.dispose()
      finnPsRef.current?.dispose()
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
