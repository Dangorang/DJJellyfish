/**
 * CropExport — static waveform with draggable crop handles + WAV export.
 *
 * Props:
 *   audioBuffer   — decoded AudioBuffer of the voice recording
 *   waveformData  — Float32Array of peak amplitudes (from buildStaticWaveform)
 *   segments      — [{ id, startTime, endTime, pitchShift, color }]
 *   pitch / bass / treble — voice effect values
 *   tracksRef     — ref to TracksSection (for getExportData())
 *   onCropChange  — callback({ start, end }) fractions [0,1]
 */
import { useRef, useState, useEffect, useCallback } from 'react'
import * as Tone from 'tone'
import { audioBufferToWav } from '../utils/audioUtils'
import { getPreset } from '../utils/beatPresets'

const HANDLE_HIT = 12 // px hit target around a handle

export function CropExport({
  audioBuffer,
  waveformData,
  segments,
  pitch,
  bass,
  treble,
  tracksRef,
  onCropChange,
}) {
  const canvasRef  = useRef(null)
  const [cropStart, setCropStart] = useState(0)
  const [cropEnd,   setCropEnd]   = useState(1)
  const [dragging,  setDragging]  = useState(null) // 'start' | 'end'
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState('')

  const cropStartRef = useRef(0)
  const cropEndRef   = useRef(1)

  const updateCrop = (start, end) => {
    setCropStart(start); setCropEnd(end)
    cropStartRef.current = start; cropEndRef.current = end
    onCropChange?.({ start, end })
  }

  // ── Draw waveform ──────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !waveformData) return
    const ctx = canvas.getContext('2d')
    const W = canvas.width, H = canvas.height

    ctx.clearRect(0, 0, W, H)

    // Bars
    const barW = W / waveformData.length
    for (let i = 0; i < waveformData.length; i++) {
      const frac = i / waveformData.length
      const inCrop = frac >= cropStart && frac <= cropEnd
      ctx.fillStyle = inCrop ? '#7c3aed' : 'rgba(124,58,237,0.25)'
      const h = waveformData[i] * H * 0.9
      ctx.fillRect(i * barW, (H - h) / 2, Math.max(1, barW - 0.5), h)
    }

    // Shadow outside crop
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.fillRect(0, 0, cropStart * W, H)
    ctx.fillRect(cropEnd * W, 0, W - cropEnd * W, H)

    // Handles
    const sx = cropStart * W
    const ex = cropEnd * W
    ctx.strokeStyle = '#00e887'; ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke()
    ctx.fillStyle = '#00e887'
    ctx.beginPath(); ctx.arc(sx, H / 2, 6, 0, Math.PI * 2); ctx.fill()

    ctx.strokeStyle = '#f97316'; ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(ex, 0); ctx.lineTo(ex, H); ctx.stroke()
    ctx.fillStyle = '#f97316'
    ctx.beginPath(); ctx.arc(ex, H / 2, 6, 0, Math.PI * 2); ctx.fill()

    // Duration label
    if (audioBuffer) {
      const dur = (cropEnd - cropStart) * audioBuffer.duration
      ctx.fillStyle = 'rgba(240,238,255,0.6)'; ctx.font = '11px system-ui'
      ctx.fillText(`${dur.toFixed(2)}s`, sx + 6, 14)
    }
  }, [waveformData, cropStart, cropEnd, audioBuffer])

  // ── Mouse interaction ──────────────────────────────────────────────────
  const clientToFrac = (e) => {
    const r = canvasRef.current.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
  }

  const onMouseDown = (e) => {
    const frac = clientToFrac(e)
    const W    = canvasRef.current.getBoundingClientRect().width
    const distStart = Math.abs(frac - cropStartRef.current) * W
    const distEnd   = Math.abs(frac - cropEndRef.current)   * W
    if (distStart < HANDLE_HIT)      setDragging('start')
    else if (distEnd < HANDLE_HIT)   setDragging('end')
  }

  const onMouseMove = useCallback((e) => {
    if (!dragging) return
    const frac = clientToFrac(e)
    if (dragging === 'start') updateCrop(Math.min(frac, cropEndRef.current - 0.02), cropEndRef.current)
    else                      updateCrop(cropStartRef.current, Math.max(frac, cropStartRef.current + 0.02))
  }, [dragging])

  const onMouseUp = () => setDragging(null)

  // ── Export ─────────────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    if (!audioBuffer || exporting) return
    setExporting(true)
    setExportProgress('Rendering audio…')

    try {
      const startSec = cropStartRef.current * audioBuffer.duration
      const endSec   = cropEndRef.current   * audioBuffer.duration
      const cropDur  = endSec - startSec

      const exportTracks = tracksRef?.current?.getExportData?.() ?? []

      const rendered = await Tone.Offline(({ transport, destination }) => {
        // ── Voice track ──
        const ps  = new Tone.PitchShift(pitch)
        const eq  = new Tone.EQ3({ low: bass, mid: 0, high: treble })
        const vVol = new Tone.Volume(0)
        const vPlayer = new Tone.Player(audioBuffer)
        vPlayer.chain(ps, eq, vVol, destination)

        // Schedule per-segment pitch shifts
        const sorted = [...(segments ?? [])].sort((a, b) => a.startTime - b.startTime)
        sorted.forEach(seg => {
          const tStart = seg.startTime - startSec
          const tEnd   = seg.endTime   - startSec
          if (tStart >= 0 && tStart < cropDur) {
            transport.schedule(() => { ps.pitch = pitch + seg.pitchShift }, tStart)
          }
          if (tEnd >= 0 && tEnd < cropDur) {
            transport.schedule(() => { ps.pitch = pitch }, tEnd)
          }
        })

        vPlayer.sync().start(0, startSec)

        // ── Backtrack layers ──
        exportTracks.forEach(track => {
          if (track.muted) return

          if (track.type === 'beat' && track.presetId) {
            const preset = getPreset(track.presetId)
            transport.bpm.value = preset.bpm

            const tVol   = new Tone.Volume(track.volume).connect(destination)
            const kick   = new Tone.MembraneSynth({ pitchDecay: 0.06, octaves: 7,
              envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.1 },
            }).connect(tVol)
            const snare  = new Tone.NoiseSynth({
              noise: { type: 'white' },
              envelope: { attack: 0.001, decay: 0.14, sustain: 0, release: 0.04 },
            }).connect(tVol)
            const hihat  = new Tone.MetalSynth({
              frequency: 500, harmonicity: 5.1, modulationIndex: 32,
              resonance: 4200, octaves: 1.5,
              envelope: { attack: 0.001, decay: 0.045, release: 0.01 },
            }).connect(tVol)

            const stepSec = Tone.Time('16n').toSeconds()
            const totalSteps = Math.ceil(cropDur / stepSec) + 16

            for (let i = 0; i < totalSteps; i++) {
              const si   = i % 16
              const time = i * stepSec
              if (time >= cropDur) break
              if (preset.kick[si])  transport.schedule(t => kick.triggerAttackRelease('C1','8n',t), time)
              if (preset.snare[si]) transport.schedule(t => snare.triggerAttackRelease('8n',t), time)
              if (preset.hihat[si]) transport.schedule(t => hihat.triggerAttackRelease('C6','32n',t), time)
            }
          }

          if (track.type === 'audio' && track.audioBuffer) {
            const tVol   = new Tone.Volume(track.volume).connect(destination)
            const player = new Tone.Player({ loop: true })
            player.connect(tVol)
            player.buffer = new Tone.ToneAudioBuffer(track.audioBuffer)
            player.sync().start(0)
          }
        })

        transport.start()
      }, cropDur)

      setExportProgress('Encoding WAV…')
      const wavBlob = audioBufferToWav(rendered.get())
      const url     = URL.createObjectURL(wavBlob)
      const a       = document.createElement('a')
      a.href = url; a.download = 'djjellyfish-mix.wav'; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
      setExportProgress('Done!')
      setTimeout(() => setExportProgress(''), 2000)
    } catch (err) {
      console.error('Export failed', err)
      setExportProgress('Export failed: ' + err.message)
    } finally {
      setExporting(false)
    }
  }, [audioBuffer, exporting, segments, pitch, bass, treble, tracksRef])

  const cropDurSec = audioBuffer
    ? ((cropEnd - cropStart) * audioBuffer.duration).toFixed(2)
    : '—'

  return (
    <div className="card crop-export-card">
      <p className="section-label">Crop &amp; Export</p>
      <p className="crop-hint">
        Drag the <span style={{ color: '#00e887' }}>green</span> (start) and{' '}
        <span style={{ color: '#f97316' }}>orange</span> (end) handles.
        Selection: <strong>{cropDurSec}s</strong>
      </p>

      <canvas
        ref={canvasRef}
        width={640}
        height={80}
        className="crop-canvas"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      />

      <div className="export-row">
        <button
          className="btn btn-export"
          onClick={handleExport}
          disabled={exporting || !audioBuffer}
        >
          {exporting ? '⏳ Rendering…' : '⬇ Export Mix (WAV)'}
        </button>
        {exportProgress && <span className="export-progress">{exportProgress}</span>}
      </div>
    </div>
  )
}
