import { PitchDetector } from 'pitchy'

// ─── Note helpers ────────────────────────────────────────────────────────────
export const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
export const BLACK_MIDI  = new Set([1,3,6,8,10])

export function midiToName(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1)
}
export function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440)
}
export function isBlackKey(midi) {
  return BLACK_MIDI.has(((midi % 12) + 12) % 12)
}

// ─── Pitch analysis ──────────────────────────────────────────────────────────
/**
 * Analyzes an AudioBuffer and returns note segments.
 * Tuned for real microphone recordings including speech and casual singing —
 * not just pristine studio takes.
 *
 * Each note: { id, startTime, duration, midi, originalMidi }
 */
export function detectNotes(audioBuffer) {
  const sampleRate = audioBuffer.sampleRate
  const data       = audioBuffer.getChannelData(0)

  // ── Parameters ──────────────────────────────────────────────────────────
  const WINDOW      = 2048   // samples per analysis frame
  const HOP         = 512    // step between frames — ~11.6ms @ 44.1 kHz
  //                           (finer than before: catches shorter notes)
  const MIN_CL      = 0.65   // clarity threshold (was 0.82 — too strict for speech)
  const MIN_FREQ    = 60     // ~B1
  const MAX_FREQ    = 2000   // ~B6
  const SEMI_TOL    = 2      // semitones of drift allowed within one segment
  const SMOOTH_R    = 2      // ±frames for median smoothing (5-frame window)
  const MIN_DUR     = 0.04   // seconds (was 0.07 — now 40 ms minimum)
  const MERGE_GAP   = 0.06   // merge notes whose gap is less than 60 ms
  const MERGE_SEMI  = 2      // …and whose pitch differs by ≤ 2 semitones

  const hopSec   = HOP / sampleRate
  const detector = PitchDetector.forFloat32Array(WINDOW)

  // ── Step 1: frame-by-frame raw pitch detection ──────────────────────────
  const frames = []
  const slice  = new Float32Array(WINDOW) // reusable buffer — avoids GC pressure

  for (let i = 0; i + WINDOW <= data.length; i += HOP) {
    slice.set(data.subarray(i, i + WINDOW))
    const [freq, clarity] = detector.findPitch(slice, sampleRate)
    const voiced = clarity >= MIN_CL && freq >= MIN_FREQ && freq <= MAX_FREQ
    frames.push({ time: i / sampleRate, midi: voiced ? freqToMidi(freq) : null })
  }

  // ── Step 2: median-smooth the MIDI values over a small window ───────────
  //   Prevents single noisy frames from breaking note segments.
  const smoothed = frames.map((f, i) => {
    if (f.midi === null) return null
    const vals = []
    for (let k = Math.max(0, i - SMOOTH_R); k <= Math.min(frames.length - 1, i + SMOOTH_R); k++) {
      if (frames[k].midi !== null) vals.push(frames[k].midi)
    }
    vals.sort((a, b) => a - b)
    return { time: f.time, midi: vals[Math.floor(vals.length / 2)] }
  })

  // ── Step 3: segment voiced frames into note objects ─────────────────────
  //   A new segment starts when pitch jumps by more than SEMI_TOL semitones.
  //   Each segment's final pitch = average of all frames inside it.
  const raw  = []   // pre-merge notes
  let cur    = null
  let uid    = 0

  for (const f of smoothed) {
    if (f !== null) {
      if (!cur || Math.abs(f.midi - cur._trackMidi) > SEMI_TOL) {
        if (cur && cur.duration >= MIN_DUR) raw.push(finalise(cur))
        cur = {
          id: uid++, startTime: f.time, duration: hopSec,
          _trackMidi: f.midi,  // last-seen midi (for drift detection)
          _sum: f.midi, _n: 1,
        }
      } else {
        cur.duration    = f.time - cur.startTime + hopSec
        cur._trackMidi  = f.midi
        cur._sum       += f.midi
        cur._n++
      }
    } else {
      if (cur && cur.duration >= MIN_DUR) raw.push(finalise(cur))
      cur = null
    }
  }
  if (cur && cur.duration >= MIN_DUR) raw.push(finalise(cur))

  // ── Step 4: merge notes that have a tiny gap but similar pitch ──────────
  //   Common in speech: brief unvoiced bursts between syllables.
  return mergeNotes(raw, MERGE_GAP, MERGE_SEMI)
}

function finalise(cur) {
  const midi = Math.round(cur._sum / cur._n)
  return { id: cur.id, startTime: cur.startTime, duration: cur.duration,
           midi, originalMidi: midi }
}

function mergeNotes(notes, maxGap, maxSemiDiff) {
  if (notes.length < 2) return notes
  const out = [{ ...notes[0] }]
  for (let i = 1; i < notes.length; i++) {
    const prev = out[out.length - 1]
    const curr = notes[i]
    const gap  = curr.startTime - (prev.startTime + prev.duration)
    if (gap <= maxGap && Math.abs(curr.midi - prev.midi) <= maxSemiDiff) {
      // Absorb curr into prev: extend duration, average pitch
      const newMidi   = Math.round((prev.midi + curr.midi) / 2)
      prev.duration   = curr.startTime + curr.duration - prev.startTime
      prev.midi       = newMidi
      prev.originalMidi = newMidi
    } else {
      out.push({ ...curr })
    }
  }
  return out
}

// ─── Static waveform ─────────────────────────────────────────────────────────
export function buildStaticWaveform(audioBuffer, numBars = 800) {
  const data      = audioBuffer.getChannelData(0)
  const blockSize = Math.floor(data.length / numBars)
  const out       = new Float32Array(numBars)
  for (let i = 0; i < numBars; i++) {
    let peak = 0
    for (let j = 0; j < blockSize; j++) {
      const v = Math.abs(data[i * blockSize + j] || 0)
      if (v > peak) peak = v
    }
    out[i] = peak
  }
  return out
}

// ─── WAV encoder ─────────────────────────────────────────────────────────────
export function audioBufferToWav(buffer) {
  const numCh = buffer.numberOfChannels
  const sr    = buffer.sampleRate
  const bps   = 2
  const blk   = numCh * bps
  const dataLen = buffer.length * blk
  const ab    = new ArrayBuffer(44 + dataLen)
  const v     = new DataView(ab)
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }

  str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true)
  str(8, 'WAVE'); str(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true)
  v.setUint16(22, numCh, true); v.setUint32(24, sr, true)
  v.setUint32(28, sr * blk, true); v.setUint16(32, blk, true)
  v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, dataLen, true)

  let off = 44
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]))
      v.setInt16(off, s < 0 ? s * 32768 : s * 32767, true)
      off += 2
    }
  }
  return new Blob([ab], { type: 'audio/wav' })
}
