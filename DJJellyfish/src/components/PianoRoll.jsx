import { useRef, useMemo } from 'react'
import { midiToName, isBlackKey } from '../utils/audioUtils'

const ROW_H    = 16   // px per semitone
const KEYS_W   = 48   // px for piano key strip
const PAD      = 3    // semitone padding around detected range
const MIN_SPAN = 24   // minimum semitone range shown (2 octaves)
const NOTE_PX  = 600  // width of the note timeline area
const MIN_NOTE_W = 8  // minimum note bar width in px (so tiny notes are clickable)

/**
 * Piano roll with draggable note segments.
 *
 * Props:
 *   notes           — [{ id, startTime, duration, midi, originalMidi }]
 *   duration        — total recording duration in seconds
 *   onNotesChange   — (notes) => void
 *   currentTime     — playback position (seconds)
 */
export function PianoRoll({ notes, duration, onNotesChange, currentTime = 0 }) {
  const dragRef = useRef(null) // { noteId, startY, startMidi }

  // ── MIDI display range ─────────────────────────────────────────────────
  const { minMidi, maxMidi } = useMemo(() => {
    if (!notes.length) return { minMidi: 48, maxMidi: 71 }
    const mids = notes.map(n => n.midi)
    const lo   = Math.min(...mids) - PAD
    const hi   = Math.max(...mids) + PAD
    const span = Math.max(hi - lo, MIN_SPAN)
    const mid  = (lo + hi) / 2
    return { minMidi: Math.floor(mid - span / 2), maxMidi: Math.ceil(mid + span / 2) }
  }, [notes])

  const numRows = maxMidi - minMidi + 1
  const rollH   = numRows * ROW_H

  // Helpers
  const midiToTop  = (m) => (maxMidi - m) * ROW_H
  const noteLeft   = (t) => (t / duration) * NOTE_PX
  const noteWidth  = (d) => Math.max(MIN_NOTE_W, (d / duration) * NOTE_PX)

  // Build row list (top = maxMidi)
  const rows = []
  for (let m = maxMidi; m >= minMidi; m--) rows.push(m)

  // ── Drag (pointer capture) ─────────────────────────────────────────────
  const onNotePointerDown = (e, noteId, startMidi) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { noteId, startY: e.clientY, startMidi }
    e.preventDefault()
  }

  const onPointerMove = (e) => {
    if (!dragRef.current) return
    const deltaMidi = Math.round((dragRef.current.startY - e.clientY) / ROW_H)
    const newMidi   = Math.max(minMidi, Math.min(maxMidi,
      dragRef.current.startMidi + deltaMidi))
    onNotesChange(notes.map(n =>
      n.id === dragRef.current.noteId ? { ...n, midi: newMidi } : n
    ))
  }

  const onPointerUp = () => { dragRef.current = null }

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="piano-roll">
      {/* Two-panel: keys (fixed) + notes (h-scrollable), shared v-scroll */}
      <div className="pr-container">

        {/* Piano keys — left column */}
        <div className="pr-keys-col" style={{ height: rollH }}>
          {rows.map(m => (
            <div
              key={m}
              className={`pr-key ${isBlackKey(m) ? 'pr-key--black' : 'pr-key--white'}`}
              style={{ top: midiToTop(m), height: ROW_H }}
            >
              {m % 12 === 0 && (
                <span className="pr-key-label">{midiToName(m)}</span>
              )}
            </div>
          ))}
        </div>

        {/* Notes area — horizontally scrollable */}
        <div
          className="pr-notes-col"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <div style={{ width: NOTE_PX, height: rollH, position: 'relative' }}>

            {/* Grid rows */}
            {rows.map(m => (
              <div
                key={m}
                className={`pr-row ${isBlackKey(m) ? 'pr-row--black' : ''}`}
                style={{ top: midiToTop(m), height: ROW_H }}
              />
            ))}

            {/* Note bars */}
            {notes.map(note => {
              const shift = note.midi - note.originalMidi
              return (
                <div
                  key={note.id}
                  className={`pr-note ${shift > 0 ? 'pr-note--up' : shift < 0 ? 'pr-note--down' : ''}`}
                  style={{
                    left:   noteLeft(note.startTime),
                    top:    midiToTop(note.midi) + 1,
                    width:  noteWidth(note.duration),
                    height: ROW_H - 2,
                  }}
                  title={`${midiToName(note.midi)}${shift ? ` (${shift > 0 ? '+' : ''}${shift} st)` : ''}`}
                  onPointerDown={e => onNotePointerDown(e, note.id, note.midi)}
                />
              )
            })}

            {/* Playhead */}
            {currentTime > 0 && (
              <div
                className="pr-playhead"
                style={{ left: noteLeft(Math.min(currentTime, duration)) }}
              />
            )}
          </div>
        </div>
      </div>

      {!notes.length && (
        <p className="pr-empty">
          No pitched notes detected — try singing or humming clearly.
        </p>
      )}
    </div>
  )
}
