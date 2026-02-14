import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Camera,
  LogOut,
  User,
  Vibrate,
  Volume2,
  Wifi,
  WifiOff,
  Gauge,
} from 'lucide-react'

import { Button } from '@/components/ui/button'

type Detection = {
  label: string
  box: [number, number, number, number]
}

type VisionPayload = {
  voice_prompt?: string
  detections?: Array<{ label?: string; box?: number[] }>
  haptic_intensity?: number
  ts?: number
}

type LogEntry = {
  id: number
  time: string
  text: string
}

const MAX_LOG_ENTRIES = 80

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function normalizeBox(raw?: number[]): [number, number, number, number] | null {
  if (!raw || raw.length !== 4) return null
  const values = raw.map((value) => clamp(Math.round(Number(value)), 0, 1000))
  const [ymin, xmin, ymax, xmax] = values
  if (Number.isNaN(ymin) || Number.isNaN(xmin) || Number.isNaN(ymax) || Number.isNaN(xmax)) {
    return null
  }
  if (ymax <= ymin || xmax <= xmin) return null
  return [ymin, xmin, ymax, xmax]
}

function formatTime(tsSeconds?: number) {
  const stamp = tsSeconds ? new Date(tsSeconds * 1000) : new Date()
  return stamp.toLocaleTimeString()
}

function apiBaseUrl() {
  const envBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim()
  if (envBase) return envBase.replace(/\/+$/, '')
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
  const host = window.location.hostname || '127.0.0.1'
  return `${protocol}//${host}:8000`
}

function Panel({
  title,
  icon,
  children,
  className = '',
}: {
  title: string
  icon?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={`rounded-2xl border border-[#ff9e3d] bg-[radial-gradient(circle_at_12%_8%,rgba(90,42,15,0.45),rgba(13,8,4,0.96)_72%)] p-4 shadow-[0_0_22px_rgba(255,158,61,0.22)] ${className}`}
    >
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-[#ffd7a4]">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  )
}

export function DashboardPage() {
  const navigate = useNavigate()
  const username = localStorage.getItem('username') || 'User'

  const [connected, setConnected] = useState(false)
  const [voicePrompt, setVoicePrompt] = useState('Waiting for analysis')
  const [hapticIntensity, setHapticIntensity] = useState(0)
  const [detections, setDetections] = useState<Detection[]>([])
  const [eventLog, setEventLog] = useState<LogEntry[]>([])
  const [videoReady, setVideoReady] = useState(false)
  const [actionBusy, setActionBusy] = useState<string | null>(null)

  const apiBase = useMemo(apiBaseUrl, [])
  const videoUrl = `${apiBase}/stream/video`
  const wsUrl = `${apiBase.replace(/^http/i, 'ws')}/stream/ws`
  const portLabel = window.location.port || '5173'

  const addLog = useCallback((text: string, tsSeconds?: number) => {
    setEventLog((current) => {
      const entry: LogEntry = {
        id: Date.now() + Math.floor(Math.random() * 10000),
        time: formatTime(tsSeconds),
        text,
      }
      return [entry, ...current].slice(0, MAX_LOG_ENTRIES)
    })
  }, [])

  const applyPayload = useCallback(
    (payload: VisionPayload, source = 'vision stream') => {
      const nextVoice = payload.voice_prompt?.trim() || 'Path is clear'
      const nextHaptic = clamp(Math.round(Number(payload.haptic_intensity ?? 0)), 0, 255)
      const rawDetections = Array.isArray(payload.detections) ? payload.detections : []
      const nextDetections: Detection[] = rawDetections
        .map((det) => {
          const box = normalizeBox(det.box)
          if (!box) return null
          return {
            label: (det.label || 'obstacle').toLowerCase(),
            box,
          }
        })
        .filter((det): det is Detection => det !== null)

      setVoicePrompt(nextVoice)
      setHapticIntensity(nextHaptic)
      setDetections(nextDetections)
      addLog(`${source}: ${nextVoice} | haptic=${nextHaptic}`, payload.ts)
    },
    [addLog],
  )

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (!token) navigate('/')
  }, [navigate])

  useEffect(() => {
    let teardown = false
    let socket: WebSocket | null = null
    let reconnectTimer: number | null = null
    let keepaliveTimer: number | null = null

    const clearTimers = () => {
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      if (keepaliveTimer) window.clearInterval(keepaliveTimer)
    }

    const connect = () => {
      if (teardown) return

      socket = new WebSocket(wsUrl)

      socket.onopen = () => {
        setConnected(true)
        addLog('WebSocket connected')

        keepaliveTimer = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send('ping')
          }
        }, 15000)
      }

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as VisionPayload
          applyPayload(payload)
        } catch {
          addLog('Invalid websocket payload')
        }
      }

      socket.onclose = () => {
        setConnected(false)
        if (keepaliveTimer) window.clearInterval(keepaliveTimer)
        if (!teardown) {
          addLog('WebSocket disconnected. Reconnecting...')
          reconnectTimer = window.setTimeout(connect, 1200)
        }
      }

      socket.onerror = () => {
        socket?.close()
      }
    }

    connect()

    return () => {
      teardown = true
      clearTimers()
      socket?.close()
    }
  }, [addLog, applyPayload, wsUrl])

  const handleLogout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('username')
    navigate('/')
  }

  const handleAnalyzeNow = async () => {
    setActionBusy('analyze')
    try {
      const response = await fetch(`${apiBase}/vision/analyze-current`)
      if (!response.ok) throw new Error(`Analyze failed (${response.status})`)
      const payload = (await response.json()) as VisionPayload
      applyPayload(payload, 'manual analyze')
    } catch (error) {
      addLog(error instanceof Error ? error.message : 'Analyze request failed')
    } finally {
      setActionBusy(null)
    }
  }

  const handleHapticPulse = async (intensity: number) => {
    const clamped = clamp(intensity, 0, 255)
    setActionBusy(`haptic-${clamped}`)
    try {
      const response = await fetch(`${apiBase}/haptic/send?intensity=${clamped}`)
      if (!response.ok) throw new Error(`Haptic send failed (${response.status})`)
      const payload = (await response.json()) as { success?: boolean; message?: string }
      setHapticIntensity(clamped)
      addLog(payload.message || `Haptic pulse ${clamped}`)
    } catch (error) {
      addLog(error instanceof Error ? error.message : 'Haptic request failed')
    } finally {
      setActionBusy(null)
    }
  }

  const handleSpeakPrompt = async () => {
    const text = voicePrompt.trim()
    if (!text) return
    setActionBusy('speak')
    try {
      const response = await fetch(`${apiBase}/tts?text=${encodeURIComponent(text)}`)
      if (response.status === 204) {
        addLog('TTS returned no audio (check ElevenLabs key)')
        return
      }
      if (!response.ok) throw new Error(`TTS failed (${response.status})`)
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      await audio.play()
      addLog('TTS playback started')
      audio.onended = () => URL.revokeObjectURL(url)
    } catch (error) {
      addLog(error instanceof Error ? error.message : 'TTS request failed')
    } finally {
      setActionBusy(null)
    }
  }

  const hapticPercent = Math.round((hapticIntensity / 255) * 100)

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_20%_0%,#3d2410_0%,#120903_50%,#060301_100%)] text-[#ffe8c2] [font-family:'Space_Grotesk','Trebuchet_MS',sans-serif]">
      <header className="border-b border-[#ff9e3d] bg-[linear-gradient(180deg,#1a0d04_0%,#130802cc_100%)] px-4 py-3 shadow-[0_4px_20px_rgba(255,158,61,0.28)]">
        <div className="mx-auto flex w-full max-w-[1700px] items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="h-3 w-3 rounded-full bg-[#ffd18b] shadow-[0_0_16px_rgba(255,209,139,0.9)]" />
            <p className="text-base font-semibold uppercase tracking-[0.22em] text-[#ffdeb2] md:text-lg">
              Echo-Sight Accessibility Dashboard
            </p>
          </div>

          <div className="flex items-center gap-3">
            <span className="rounded-full border border-[#ff9e3d] bg-[#4d230a] px-4 py-1.5 text-sm uppercase tracking-[0.15em] text-[#ffd9a5]">
              Frontend : {portLabel}
            </span>
            <span
              className={`flex items-center gap-2 text-sm tracking-[0.12em] ${
                connected ? 'text-[#ffe3b8]' : 'text-[#ffc4b3]'
              }`}
            >
              {connected ? <Wifi className="h-5 w-5" /> : <WifiOff className="h-5 w-5" />}
              {connected ? 'WebSocket connected' : 'WebSocket disconnected'}
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1700px] grid-cols-1 gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="relative min-h-[72vh] overflow-hidden rounded-2xl border border-[#ff9e3d] bg-black shadow-[0_0_36px_rgba(255,158,61,0.22)]">
          <img
            src={videoUrl}
            alt="Echo-Sight live feed"
            className="h-full w-full object-cover"
            onLoad={() => setVideoReady(true)}
            onError={() => setVideoReady(false)}
          />

          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_38%,rgba(0,0,0,0.45)_100%)]" />

          {!videoReady && (
            <div className="absolute left-6 top-6 rounded border border-[#ffd86d] bg-[#5a3a0ecc] px-5 py-4 text-[#fff1c8] shadow-[0_0_16px_rgba(255,216,109,0.4)]">
              <p className="text-2xl font-semibold uppercase tracking-[0.08em]">Echo-Sight Demo Mode</p>
              <p className="mt-2 text-lg">Waiting for live camera stream on `{videoUrl}`</p>
            </div>
          )}

          {detections.map((detection, index) => {
            const [ymin, xmin, ymax, xmax] = detection.box
            return (
              <div
                key={`${detection.label}-${index}`}
                className="absolute border-[3px] border-[#ffca72] shadow-[0_0_20px_rgba(255,202,114,0.9)]"
                style={{
                  left: `${(xmin / 1000) * 100}%`,
                  top: `${(ymin / 1000) * 100}%`,
                  width: `${((xmax - xmin) / 1000) * 100}%`,
                  height: `${((ymax - ymin) / 1000) * 100}%`,
                }}
              >
                <span className="absolute -top-7 left-0 border border-[#ffca72] bg-[#5c3408] px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.06em] text-[#fff2d6]">
                  {detection.label}
                </span>
              </div>
            )
          })}
        </section>

        <aside className="flex flex-col gap-3">
          <Panel title="App Source" icon={<Gauge className="h-5 w-5" />}>
            <p className="text-base leading-7 text-[#ffe5c0]">
              React UI port: <span className="font-semibold text-[#fff0d8]">{portLabel}</span>
            </p>
            <p className="text-base leading-7 text-[#ffe5c0]">
              Backend API/video/ws source:
              <br />
              <span className="font-semibold text-[#fff0d8]">{apiBase}</span>
            </p>
            <div className="mt-3 flex items-center justify-between border-t border-[#ff9e3d66] pt-3">
              <span className="flex items-center gap-2 text-base text-[#ffdcae]">
                <User className="h-5 w-5" /> {username}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-10 border border-[#ff9e3d66] px-4 text-[#ffe8c2] hover:bg-[#ff9e3d1f] hover:text-white"
                onClick={handleLogout}
              >
                <LogOut className="mr-2 h-5 w-5" />
                Logout
              </Button>
            </div>
          </Panel>

          <Panel title="Hardware Controls" icon={<Vibrate className="h-5 w-5" />}>
            <div className="grid grid-cols-2 gap-2">
              <Button
                onClick={handleAnalyzeNow}
                disabled={actionBusy !== null}
                className="h-12 bg-[#ffb347] text-base font-semibold text-[#2c1403] hover:bg-[#ffc06a]"
              >
                <Camera className="mr-2 h-5 w-5" />
                Analyze Now
              </Button>
              <Button
                onClick={() => handleSpeakPrompt()}
                disabled={actionBusy !== null}
                className="h-12 bg-[#ffd08a] text-base font-semibold text-[#2c1403] hover:bg-[#ffdcaa]"
              >
                <Volume2 className="mr-2 h-5 w-5" />
                Speak Prompt
              </Button>
              <Button
                onClick={() => handleHapticPulse(120)}
                disabled={actionBusy !== null}
                className="h-12 bg-[#ffa03a] text-base font-semibold text-[#2c1403] hover:bg-[#ffb35f]"
              >
                <Vibrate className="mr-2 h-5 w-5" />
                Pulse 120
              </Button>
              <Button
                onClick={() => handleHapticPulse(220)}
                disabled={actionBusy !== null}
                className="h-12 bg-[#ff7f2d] text-base font-semibold text-[#2c1403] hover:bg-[#ff9550]"
              >
                <Vibrate className="mr-2 h-5 w-5" />
                Max Alert
              </Button>
            </div>
          </Panel>

          <Panel title="Voice Prompt" icon={<Volume2 className="h-5 w-5" />}>
            <p className="min-h-[64px] text-4xl leading-tight text-[#fff0d7]">{voicePrompt}</p>
          </Panel>

          <Panel title="Haptic Intensity (0-255)" icon={<Vibrate className="h-5 w-5" />}>
            <p className="text-6xl text-[#ffdbac]">{hapticIntensity}</p>
            <div className="mt-3 h-7 overflow-hidden rounded-full border border-[#ff9e3d] bg-[#4e260a]">
              <div
                className="h-full bg-[linear-gradient(90deg,#ffe7c1_0%,#ffd28d_55%,#ff9d3a_100%)] shadow-[0_0_18px_rgba(255,181,91,0.55)] transition-all duration-200"
                style={{ width: `${hapticPercent}%` }}
              />
            </div>
          </Panel>

          <Panel title="Detections" icon={<Camera className="h-5 w-5" />}>
            {detections.length === 0 ? (
              <p className="text-xl text-[#ffe0b5]">No active obstacles</p>
            ) : (
              <div className="space-y-2">
                {detections.map((detection, index) => (
                  <p
                    key={`${detection.label}-${index}`}
                    className="rounded-md border border-[#ff9e3d66] bg-[#4d240bcf] px-3 py-2 text-base text-[#fff0d7]"
                  >
                    {detection.label} :: [{detection.box.join(', ')}]
                  </p>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Event Log" icon={<Gauge className="h-5 w-5" />} className="flex-1">
            <div className="max-h-[270px] space-y-2 overflow-y-auto pr-1 text-sm text-[#ffd8a6]">
              {eventLog.length === 0 && <p>Waiting for websocket events...</p>}
              {eventLog.map((entry) => (
                <p key={entry.id} className="border-b border-[#ff9e3d33] pb-2">
                  <span className="text-[#ffc276]">[{entry.time}]</span> {entry.text}
                </p>
              ))}
            </div>
          </Panel>
        </aside>
      </div>
    </main>
  )
}
