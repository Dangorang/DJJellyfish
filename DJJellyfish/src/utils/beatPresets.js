/**
 * 16-step patterns: 1 = hit, 0 = rest
 * Indexes map to 16th-note positions within one bar.
 */
export const BEAT_PRESETS = [
  {
    id: 'basic',
    name: 'Basic',
    emoji: '🥁',
    bpm: 90,
    kick:  [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0],
    snare: [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],
    hihat: [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0],
  },
  {
    id: 'hiphop',
    name: 'Hip-Hop',
    emoji: '🎤',
    bpm: 85,
    kick:  [1,0,0,1, 0,0,1,0, 1,0,0,0, 0,1,0,0],
    snare: [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,1],
    hihat: [0,1,0,1, 0,1,0,1, 0,1,0,1, 0,1,0,0],
  },
  {
    id: 'trap',
    name: 'Trap',
    emoji: '⚡',
    bpm: 140,
    kick:  [1,0,0,0, 1,0,0,1, 0,0,1,0, 0,0,0,0],
    snare: [0,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,1,0],
    hihat: [1,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1,1],
  },
  {
    id: 'boombap',
    name: 'Boom Bap',
    emoji: '🔥',
    bpm: 95,
    kick:  [1,0,0,0, 0,0,1,0, 0,1,0,0, 1,0,0,0],
    snare: [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],
    hihat: [1,0,1,0, 0,1,0,0, 1,0,1,0, 0,1,0,0],
  },
  {
    id: 'lofi',
    name: 'Lo-Fi',
    emoji: '☕',
    bpm: 75,
    kick:  [1,0,0,0, 0,0,0,0, 1,0,0,0, 0,1,0,0],
    snare: [0,0,0,0, 1,0,0,1, 0,0,0,0, 1,0,0,0],
    hihat: [1,0,0,1, 0,0,1,0, 1,0,0,1, 0,0,1,0],
  },
]

export function getPreset(id) {
  return BEAT_PRESETS.find(p => p.id === id) ?? BEAT_PRESETS[0]
}
