import { useRef, useEffect } from 'react'

/**
 * Draws a live waveform on a canvas.
 * Props:
 *   getWaveformData — function returning Float32Array | null
 *   isActive        — boolean (drives the animation)
 *   color           — hex/rgb string
 */
export function WaveformCanvas({ getWaveformData, isActive, color = '#00d4ff' }) {
  const canvasRef = useRef(null)
  const rafRef = useRef(null)

  // Keep refs so the draw loop never becomes stale without restarting
  const getDataRef = useRef(getWaveformData)
  const isActiveRef = useRef(isActive)
  const colorRef = useRef(color)

  useEffect(() => { getDataRef.current = getWaveformData }, [getWaveformData])
  useEffect(() => { isActiveRef.current = isActive }, [isActive])
  useEffect(() => { colorRef.current = color }, [color])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')

    const draw = () => {
      const W = canvas.width
      const H = canvas.height
      const c = colorRef.current

      ctx.clearRect(0, 0, W, H)

      const data = isActiveRef.current ? getDataRef.current?.() : null

      if (!data || data.length === 0) {
        // Idle flat line
        ctx.beginPath()
        ctx.strokeStyle = c + '30'
        ctx.lineWidth = 2
        ctx.moveTo(0, H / 2)
        ctx.lineTo(W, H / 2)
        ctx.stroke()
      } else {
        // Outer glow pass
        ctx.beginPath()
        ctx.strokeStyle = c + '44'
        ctx.lineWidth = 6
        ctx.shadowBlur = 18
        ctx.shadowColor = c
        tracePath(ctx, data, W, H)
        ctx.stroke()

        // Sharp inner line
        ctx.beginPath()
        ctx.strokeStyle = c
        ctx.lineWidth = 2
        ctx.shadowBlur = 8
        ctx.shadowColor = c
        tracePath(ctx, data, W, H)
        ctx.stroke()

        ctx.shadowBlur = 0
      }

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, []) // runs once; dynamics handled via refs above

  return (
    <canvas
      ref={canvasRef}
      width={650}
      height={110}
      className="waveform-canvas"
    />
  )
}

function tracePath(ctx, data, W, H) {
  const step = W / data.length
  for (let i = 0; i < data.length; i++) {
    const x = i * step
    const y = ((data[i] + 1) / 2) * H
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
}
