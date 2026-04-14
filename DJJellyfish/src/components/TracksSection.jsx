/**
 * TracksSection — multi-track mixer.
 *
 * The voice track lives in App.jsx.  This component owns N backtrack slots,
 * each of which can be a beat-preset (Tone.js synths) or an uploaded audio file
 * (Tone.Player).  It exposes startAll / stopAll via a forwarded ref so App can
 * synchronise them with the voice player.
 *
 * Track data structure (held in local state):
 *   { id, name, type:'beat'|'audio', presetId?, blob?, audioBuffer?,
 *     volume, muted }
 */
import {
  forwardRef, useImperativeHandle, useRef, useState, useEffect, useCallback,
} from 'react'
import * as Tone from 'tone'
import { BEAT_PRESETS, getPreset } from '../utils/beatPresets'

// ─── Synth factory helpers ────────────────────────────────────────────────────
function makeBeatSynths(volNode) {
  const kick = new Tone.MembraneSynth({
    pitchDecay: 0.06, octaves: 7,
    envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.1 },
  }).connect(volNode)

  const snare = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.14, sustain: 0, release: 0.04 },
  }).connect(volNode)

  const hihat = new Tone.MetalSynth({
    frequency: 500, harmonicity: 5.1, modulationIndex: 32,
    resonance: 4200, octaves: 1.5,
    envelope: { attack: 0.001, decay: 0.045, release: 0.01 },
  }).connect(volNode)

  return { kick, snare, hihat }
}

function buildSequence(preset, synths) {
  const steps = preset.kick.map((k, i) => ({
    k, s: preset.snare[i], h: preset.hihat[i],
  }))
  return new Tone.Sequence((time, step) => {
    if (step.k) synths.kick.triggerAttackRelease('C1', '8n', time)
    if (step.s) synths.snare.triggerAttackRelease('8n', time)
    if (step.h) synths.hihat.triggerAttackRelease('C6', '32n', time)
  }, steps, '16n')
}

// ─── TracksSection ────────────────────────────────────────────────────────────
export const TracksSection = forwardRef(function TracksSection(_, ref) {
  const [tracks, setTracks] = useState([])
  // engines: Map<id, { volNode, synths?, seq?, player?, blobUrl? }>
  const enginesRef = useRef(new Map())
  const nextId     = useRef(1)

  // ── Imperative API for App.jsx ─────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    /** Start all unmuted tracks at the given Tone.js audio-context time */
    startAll(startAt) {
      const hasBeat = [...enginesRef.current.values()].some(e => e.seq)
      if (hasBeat) {
        const t = Tone.getTransport()
        t.stop(); t.cancel(); t.position = 0
      }

      enginesRef.current.forEach((engine, id) => {
        const track = tracks.find(t => t.id === id)
        if (!track || track.muted) return

        if (engine.seq) {
          const preset = getPreset(track.presetId)
          Tone.getTransport().bpm.value = preset.bpm
          engine.seq.start(0)
        }
        if (engine.player && engine.player.loaded) {
          engine.player.start(startAt)
        }
      })

      if (hasBeat) Tone.getTransport().start(startAt)
    },

    /** Stop all tracks immediately */
    stopAll() {
      enginesRef.current.forEach(engine => {
        engine.seq?.stop()
        engine.player?.stop()
      })
      Tone.getTransport().stop()
    },

    /** Collect data needed for mixed export */
    getExportData() {
      return tracks.map(track => {
        const engine = enginesRef.current.get(track.id)
        return { ...track, audioBuffer: engine?.audioBuffer ?? null }
      })
    },
  }), [tracks])

  // ── Cleanup on unmount ──────────────────────────────────────────────────
  useEffect(() => {
    return () => disposeAll()
  }, [])

  function disposeAll() {
    enginesRef.current.forEach(disposeEngine)
    enginesRef.current.clear()
  }

  function disposeEngine(engine) {
    engine.seq?.dispose()
    engine.player?.dispose()
    engine.synths?.kick?.dispose()
    engine.synths?.snare?.dispose()
    engine.synths?.hihat?.dispose()
    engine.volNode?.dispose()
    if (engine.blobUrl) URL.revokeObjectURL(engine.blobUrl)
  }

  // ── Add beat track ──────────────────────────────────────────────────────
  const addBeatTrack = useCallback(async () => {
    await Tone.start()
    const id      = `track-${nextId.current++}`
    const preset  = BEAT_PRESETS[0]
    const volNode = new Tone.Volume(-6).toDestination()
    const synths  = makeBeatSynths(volNode)
    const seq     = buildSequence(preset, synths)

    enginesRef.current.set(id, { volNode, synths, seq })
    setTracks(prev => [...prev, {
      id, name: `Beat ${nextId.current - 1}`, type: 'beat',
      presetId: preset.id, volume: -6, muted: false,
    }])
  }, [])

  // ── Add audio track (file upload) ───────────────────────────────────────
  const addAudioTrack = useCallback(async (file) => {
    await Tone.start()
    const id       = `track-${nextId.current++}`
    const blobUrl  = URL.createObjectURL(file)
    const volNode  = new Tone.Volume(-6).toDestination()

    // Also decode for export
    const arrayBuf = await file.arrayBuffer()
    const audioBuffer = await Tone.getContext().rawContext.decodeAudioData(arrayBuf)

    const player = new Tone.Player({ url: blobUrl, loop: true }).connect(volNode)

    enginesRef.current.set(id, { volNode, player, blobUrl, audioBuffer })
    setTracks(prev => [...prev, {
      id, name: file.name.replace(/\.[^.]+$/, ''), type: 'audio',
      volume: -6, muted: false,
    }])
  }, [])

  // ── Change beat preset ──────────────────────────────────────────────────
  const changePreset = useCallback((id, presetId) => {
    const engine = enginesRef.current.get(id)
    if (!engine || !engine.synths) return

    engine.seq?.dispose()
    const preset = getPreset(presetId)
    const seq    = buildSequence(preset, engine.synths)
    engine.seq   = seq

    setTracks(prev => prev.map(t => t.id === id ? { ...t, presetId } : t))
  }, [])

  // ── Volume / mute ───────────────────────────────────────────────────────
  const setVolume = useCallback((id, db) => {
    const engine = enginesRef.current.get(id)
    if (engine) engine.volNode.volume.value = db
    setTracks(prev => prev.map(t => t.id === id ? { ...t, volume: db } : t))
  }, [])

  const toggleMute = useCallback((id) => {
    setTracks(prev => prev.map(t => {
      if (t.id !== id) return t
      const muted = !t.muted
      const engine = enginesRef.current.get(id)
      if (engine) engine.volNode.mute = muted
      return { ...t, muted }
    }))
  }, [])

  // ── Remove track ────────────────────────────────────────────────────────
  const removeTrack = useCallback((id) => {
    const engine = enginesRef.current.get(id)
    if (engine) { disposeEngine(engine); enginesRef.current.delete(id) }
    setTracks(prev => prev.filter(t => t.id !== id))
  }, [])

  // ── Handle file input ───────────────────────────────────────────────────
  const fileInputRef = useRef(null)

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="card tracks-section">
      <div className="tracks-header">
        <span className="section-label">Tracks</span>
        <div className="tracks-add-btns">
          <button className="btn-add-track" onClick={addBeatTrack}>+ Beat</button>
          <button className="btn-add-track" onClick={() => fileInputRef.current?.click()}>
            + Upload
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            style={{ display: 'none' }}
            onChange={e => { if (e.target.files[0]) addAudioTrack(e.target.files[0]); e.target.value = '' }}
          />
        </div>
      </div>

      {tracks.length === 0 && (
        <p className="empty-hint">Add a beat or upload a backtrack to mix with your voice.</p>
      )}

      {tracks.map(track => (
        <div key={track.id} className={`track-strip ${track.muted ? 'track-strip--muted' : ''}`}>
          {/* Type icon */}
          <div className="track-icon">
            {track.type === 'beat' ? '🥁' : '🎵'}
          </div>

          {/* Name + preset selector */}
          <div className="track-info">
            <span className="track-name">{track.name}</span>
            {track.type === 'beat' && (
              <div className="preset-pills">
                {BEAT_PRESETS.map(p => (
                  <button
                    key={p.id}
                    className={`preset-pill ${track.presetId === p.id ? 'active' : ''}`}
                    onClick={() => changePreset(track.id, p.id)}
                    title={p.name}
                  >
                    {p.emoji} {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Volume slider */}
          <div className="track-vol">
            <input
              type="range"
              className="vol-slider"
              min={-40} max={6} step={1}
              value={track.volume}
              onChange={e => setVolume(track.id, Number(e.target.value))}
            />
            <span className="track-vol-label">{track.volume > 0 ? '+' : ''}{track.volume}</span>
          </div>

          {/* Mute */}
          <button
            className={`track-mute-btn ${track.muted ? 'muted' : ''}`}
            onClick={() => toggleMute(track.id)}
            title="Mute"
          >
            {track.muted ? '🔇' : '🔊'}
          </button>

          {/* Remove */}
          <button className="track-remove-btn" onClick={() => removeTrack(track.id)} title="Remove">
            ✕
          </button>
        </div>
      ))}
    </div>
  )
})
