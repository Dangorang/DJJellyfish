/**
 * SegmentEditor — visual pitch editor based on user-drawn time segments.
 *
 * The Y axis is pitch SHIFT in semitones (-12 to +12).
 * The X axis is time (0 → duration).
 * The faint waveform shows in the background for reference.
 *
 * Interactions:
 *   Click + drag horizontally on empty grid  → create a new segment
 *   Drag segment bar up / down              → change its pitch shift
 *   Drag left / right edges of a segment    → resize start / end time
 *   Click a segment                          → select it
 *   Delete / Backspace with segment selected → delete it
 *   "Auto-detect" button                     → run pitchy to pre-fill segments
 */
import { useRef, useState, useEffect, useCallback } from 'react'
import { detectNotes } from '../utils/audioUtils'

// ─── Constants ────────────────────────────────────────────────────────────────
const PALETTE   = ['#7c3aed','#0891b2','#059669','#d97706','#dc2626','#db2777']
const LABEL_W   = 44    // left column width (semitone labels)
const ROW_H     = 11    // px per semitone row
const SEMIS     = 25    // rows: +12 … 0 … -12
const GRID_H    = SEMIS * ROW_H   // 275 px
const RULER_H   = 24              // time ruler below grid
const TOTAL_H   = GRID_H + RULER_H
const NOTE_W    = 600   // timeline width in px
const MIN_PX    = 6     // minimum segment width before creation is accepted

// ─── Coordinate helpers ───────────────────────────────────────────────────────
const pitchToY  = (p) => (12 - Math.max(-12, Math.min(12, p))) * ROW_H
const yToPitch  = (y) => Math.max(-12, Math.min(12, Math.round(12 - y / ROW_H)))
const timeToX   = (t, dur) => (t / dur) * NOTE_W
const xToTime   = (x, dur) => Math.max(0, Math.min(dur, (x / NOTE_W) * dur))

// ─── SegmentEditor ────────────────────────────────────────────────────────────
export function SegmentEditor({
  waveformData,   // Float32Array peak values for background waveform
  duration,       // recording duration in seconds
  audioBuffer,    // native AudioBuffer (for auto-detect)
  segments,       // [{ id, startTime, endTime, pitchShift, color }]
  onSegmentsChange,
  currentTime,    // playback position in seconds
}) {
  const bgRef    = useRef(null)  // background canvas
  const contRef  = useRef(null)  // content div (for getBoundingClientRect)
  const dragRef  = useRef(null)  // current drag state

  // Refs mirror props/state for use inside window listeners (no stale closures)
  const segsRef   = useRef(segments)
  const durRef    = useRef(duration)
  const onChgRef  = useRef(onSegmentsChange)
  useEffect(() => { segsRef.current  = segments },          [segments])
  useEffect(() => { durRef.current   = duration },          [duration])
  useEffect(() => { onChgRef.current = onSegmentsChange },  [onSegmentsChange])

  const [selectedId, setSelectedId] = useState(null)

  // Preview state + ref (needed inside window handler closures)
  const [previewState, setPreviewState] = useState(null)
  const previewRef = useRef(null)
  const setPreview = useCallback((val) => {
    const v = typeof val === 'function' ? val(previewRef.current) : val
    previewRef.current = v
    setPreviewState(v)
  }, [])

  const colorIdx = useRef(0)
  const nextColor = () => PALETTE[colorIdx.current++ % PALETTE.length]

  // ── Draw background canvas ────────────────────────────────────────────
  useEffect(() => {
    const canvas = bgRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, NOTE_W, TOTAL_H)

    // Semitone row backgrounds + key lines
    for (let i = 0; i < SEMIS; i++) {
      const y    = i * ROW_H
      const semi = 12 - i

      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.025)'
        ctx.fillRect(0, y, NOTE_W, ROW_H)
      }

      if (semi === 0) {
        // Center (no-shift) line — clearly marked
        ctx.strokeStyle = 'rgba(255,255,255,0.28)'
        ctx.lineWidth = 1.5
        ctx.setLineDash([5, 4])
        ctx.beginPath()
        ctx.moveTo(0, y + ROW_H / 2)
        ctx.lineTo(NOTE_W, y + ROW_H / 2)
        ctx.stroke()
        ctx.setLineDash([])
      } else if (semi % 6 === 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.08)'
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(NOTE_W, y); ctx.stroke()
      }
    }

    // Faint waveform in background
    if (waveformData) {
      ctx.fillStyle = 'rgba(255,255,255,0.06)'
      const bw = NOTE_W / waveformData.length
      for (let i = 0; i < waveformData.length; i++) {
        const h = waveformData[i] * GRID_H * 0.82
        ctx.fillRect(i * bw, (GRID_H - h) / 2, Math.max(1, bw - 0.5), h)
      }
    }

    // Time ruler
    ctx.fillStyle = 'rgba(0,0,0,0.4)'
    ctx.fillRect(0, GRID_H, NOTE_W, RULER_H)
    ctx.font = '10px system-ui'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = 'rgba(240,238,255,0.35)'

    const step = duration <= 5 ? 0.5 : duration <= 20 ? 1 : duration <= 60 ? 5 : 10
    for (let t = 0; t <= duration + 0.001; t += step) {
      const x = timeToX(t, duration)
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x, GRID_H); ctx.lineTo(x, GRID_H + 7); ctx.stroke()
      ctx.fillText(t.toFixed(t < 10 ? 1 : 0) + 's', x + 2, GRID_H + RULER_H / 2)
    }
  }, [waveformData, duration])

  // ── Global pointermove / pointerup (handles all drag types) ──────────
  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current
      if (!d) return

      if (d.type === 'create') {
        const x = getX(e)
        setPreview(p => p ? { ...p, endX: x } : null)
        return
      }

      const segs = segsRef.current
      if (d.type === 'move') {
        const deltaSemi = Math.round((d.startY - e.clientY) / ROW_H)
        const newPitch  = Math.max(-12, Math.min(12, d.origPitch + deltaSemi))
        onChgRef.current(segs.map(s => s.id === d.segId ? { ...s, pitchShift: newPitch } : s))
      } else if (d.type === 'resize-start') {
        const dt = ((e.clientX - d.startX) / NOTE_W) * durRef.current
        const ns = Math.max(0, Math.min(d.origEnd - 0.05, d.origStart + dt))
        onChgRef.current(segs.map(s => s.id === d.segId ? { ...s, startTime: ns } : s))
      } else if (d.type === 'resize-end') {
        const dt = ((e.clientX - d.startX) / NOTE_W) * durRef.current
        const ne = Math.min(durRef.current, Math.max(d.origStart + 0.05, d.origEnd + dt))
        onChgRef.current(segs.map(s => s.id === d.segId ? { ...s, endTime: ne } : s))
      }
    }

    const onUp = () => {
      const d = dragRef.current
      dragRef.current = null

      if (d?.type === 'create') {
        const p = previewRef.current
        if (p) {
          const x1 = Math.min(p.startX, p.endX)
          const x2 = Math.max(p.startX, p.endX)
          if (x2 - x1 >= MIN_PX) {
            const dur    = durRef.current
            const newSeg = {
              id:         `seg-${Date.now()}`,
              startTime:  xToTime(x1, dur),
              endTime:    xToTime(x2, dur),
              pitchShift: p.pitch,
              color:      nextColor(),
            }
            onChgRef.current([...segsRef.current, newSeg])
            setSelectedId(newSeg.id)
          }
        }
        setPreview(null)
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup',   onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup',   onUp)
    }
  }, [setPreview]) // stable deps only

  // ── Coordinate helper (relative to content div) ───────────────────────
  const getX  = (e) => e.clientX - (contRef.current?.getBoundingClientRect().left ?? 0)
  const getXY = (e) => {
    const r = contRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 }
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  // ── Grid mousedown → start creating a segment ─────────────────────────
  const onGridMouseDown = (e) => {
    if (e.button !== 0) return
    const { x, y } = getXY(e)
    if (y > GRID_H) return  // ruler area, ignore
    const pitch = yToPitch(y)
    dragRef.current = { type: 'create' }
    setPreview({ startX: x, endX: x, pitch })
    setSelectedId(null)
  }

  // ── Segment / handle pointerdown ──────────────────────────────────────
  const startSegDrag = (e, seg, type) => {
    e.stopPropagation()
    setSelectedId(seg.id)
    dragRef.current = {
      type,
      segId:     seg.id,
      startY:    e.clientY,
      startX:    e.clientX,
      origPitch: seg.pitchShift,
      origStart: seg.startTime,
      origEnd:   seg.endTime,
    }
  }

  // ── Delete key ────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (!selectedId) return
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (document.activeElement?.tagName === 'INPUT') return
      onSegmentsChange(segments.filter(s => s.id !== selectedId))
      setSelectedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, segments, onSegmentsChange])

  // ── Auto-detect ───────────────────────────────────────────────────────
  const handleAutoDetect = useCallback(() => {
    if (!audioBuffer) return
    colorIdx.current = 0
    const notes = detectNotes(audioBuffer)
    onSegmentsChange(notes.map(n => ({
      id:         `auto-${n.id}`,
      startTime:  n.startTime,
      endTime:    n.startTime + n.duration,
      pitchShift: 0,
      color:      nextColor(),
    })))
    setSelectedId(null)
  }, [audioBuffer, onSegmentsChange])

  // ── Derived display values ────────────────────────────────────────────
  const selectedSeg = segments.find(s => s.id === selectedId) ?? null
  const LABEL_TICKS = [12, 9, 6, 3, 0, -3, -6, -9, -12]

  return (
    <div className="seg-editor">

      {/* Header */}
      <div className="seg-editor-header">
        <div className="seg-legend">
          <span className="seg-tip">↔ drag to <strong>create</strong></span>
          <span className="seg-tip">↕ drag segment to <strong>set pitch</strong></span>
          <span className="seg-tip seg-tip-dim">↔ drag edges to <strong>resize</strong></span>
        </div>
        <div className="seg-actions">
          {selectedSeg && (
            <button className="seg-btn seg-btn-del"
              onClick={() => { onSegmentsChange(segments.filter(s => s.id !== selectedId)); setSelectedId(null) }}>
              ✕ Delete
            </button>
          )}
          <button className="seg-btn" onClick={handleAutoDetect} disabled={!audioBuffer}
            title="Try to auto-detect pitched regions (works best with clear singing)">
            Auto-detect
          </button>
          {segments.length > 0 && (
            <button className="seg-btn"
              onClick={() => { onSegmentsChange([]); setSelectedId(null) }}>
              Clear all
            </button>
          )}
        </div>
      </div>

      {/* Grid */}
      <div className="seg-outer">

        {/* Semitone labels */}
        <div className="seg-labels" style={{ height: TOTAL_H }}>
          {LABEL_TICKS.map(s => (
            <div key={s} className={`seg-label ${s === 0 ? 'seg-label--zero' : ''}`}
              style={{ top: pitchToY(s) + ROW_H / 2 }}>
              {s > 0 ? '+' : ''}{s}
            </div>
          ))}
        </div>

        {/* Content */}
        <div
          ref={contRef}
          className="seg-content"
          style={{ width: NOTE_W, height: TOTAL_H }}
          onPointerDown={onGridMouseDown}
        >
          {/* Background canvas: grid lines + waveform + ruler */}
          <canvas ref={bgRef} width={NOTE_W} height={TOTAL_H}
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />

          {/* Segment bars */}
          {segments.map(seg => {
            const x  = timeToX(seg.startTime, duration)
            const w  = Math.max(MIN_PX, timeToX(seg.endTime, duration) - x)
            const y  = pitchToY(seg.pitchShift)
            const sel = seg.id === selectedId
            return (
              <div key={seg.id}
                className={`seg-bar ${sel ? 'seg-bar--sel' : ''}`}
                style={{ left: x, top: y, width: w, height: ROW_H - 1, background: seg.color }}
                onPointerDown={e => startSegDrag(e, seg, 'move')}
              >
                <div className="seg-edge seg-edge-l"
                  onPointerDown={e => startSegDrag(e, seg, 'resize-start')} />
                <span className="seg-bar-label">
                  {seg.pitchShift > 0 ? '+' : ''}{seg.pitchShift}
                </span>
                <div className="seg-edge seg-edge-r"
                  onPointerDown={e => startSegDrag(e, seg, 'resize-end')} />
              </div>
            )
          })}

          {/* Preview while creating */}
          {previewState && (
            <div className="seg-preview" style={{
              left:   Math.min(previewState.startX, previewState.endX),
              top:    pitchToY(previewState.pitch),
              width:  Math.max(1, Math.abs(previewState.endX - previewState.startX)),
              height: ROW_H - 1,
            }} />
          )}

          {/* Playhead */}
          {currentTime > 0 && currentTime < duration && (
            <div className="seg-playhead"
              style={{ left: timeToX(currentTime, duration) }} />
          )}
        </div>
      </div>

      {/* Info bar */}
      {selectedSeg ? (
        <div className="seg-info">
          <span>{selectedSeg.startTime.toFixed(2)}s → {selectedSeg.endTime.toFixed(2)}s</span>
          <span className="seg-info-pitch">
            {selectedSeg.pitchShift > 0 ? '+' : ''}{selectedSeg.pitchShift} semitones
          </span>
          <span className="seg-info-hint">drag ↕ to adjust · edges ↔ to resize · Del to remove</span>
        </div>
      ) : (
        <p className="empty-hint" style={{ padding: '0.25rem 0' }}>
          {segments.length === 0
            ? 'Click and drag on the grid to create a pitch region.'
            : 'Click a segment to select it.'}
        </p>
      )}
    </div>
  )
}
