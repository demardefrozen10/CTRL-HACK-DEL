import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LogOut, User, Wifi, WifiOff } from 'lucide-react'

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

const MAX_LOG_ENTRIES = 60

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
  children,
  className = '',
}: {
  title: string
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={`rounded-xl border border-[#02d9cb] bg-[radial-gradient(circle_at_20%_10%,rgba(19,60,95,0.45),rgba(0,0,0,0.96)_72%)] p-4 shadow-[0_0_26px_rgba(2,217,203,0.15)] ${className}`}
    >
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.24em] text-[#8efff4]">
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

  const apiBase = useMemo(apiBaseUrl, [])
  const videoUrl = `${apiBase}/stream/video`
  const wsUrl = `${apiBase.replace(/^http/i, 'ws')}/stream/ws`

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
          addLog(`${nextVoice} | haptic=${nextHaptic}`, payload.ts)
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
  }, [addLog, wsUrl])

  const handleLogout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('username')
    navigate('/')
  }

  const hapticPercent = Math.round((hapticIntensity / 255) * 100)

  return (
    <main className="min-h-screen bg-[#01080b] text-[#c8fff8] [font-family:'Space_Grotesk','Trebuchet_MS',sans-serif]">
      <header className="border-b border-[#0ad7cb] bg-[linear-gradient(180deg,#02090d_0%,#02090dcc_100%)] px-4 py-3 shadow-[0_4px_18px_rgba(10,215,203,0.2)]">
        <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="h-2.5 w-2.5 rounded-full bg-[#83ffdc] shadow-[0_0_14px_rgba(131,255,220,0.9)]" />
            <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[#8dfff4] md:text-base">
              Echo-Sight React Frontend
            </p>
          </div>

          <div className="flex items-center gap-3">
            <span className="rounded-full border border-[#0ad7cb] bg-[#013331] px-3 py-1 text-xs uppercase tracking-[0.18em] text-[#8dfff4]">
              Frontend : {window.location.port || '5173'}
            </span>
            <span
              className={`flex items-center gap-1 text-xs tracking-[0.14em] ${
                connected ? 'text-[#8dffcb]' : 'text-[#ff9c9c]'
              }`}
            >
              {connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
              {connected ? 'WebSocket connected' : 'WebSocket disconnected'}
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1600px] grid-cols-1 gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="relative min-h-[70vh] overflow-hidden rounded-xl border border-[#0ad7cb] bg-black shadow-[0_0_35px_rgba(10,215,203,0.16)]">
          <img
            src={videoUrl}
            alt="Echo-Sight live feed"
            className="h-full w-full object-cover"
            onLoad={() => setVideoReady(true)}
            onError={() => setVideoReady(false)}
          />

          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_40%,rgba(0,0,0,0.35)_100%)]" />

          {!videoReady && (
            <div className="absolute left-6 top-6 rounded border border-[#d2ef1b] bg-[#102f1acc] px-4 py-3 text-[#d2ef1b] shadow-[0_0_16px_rgba(210,239,27,0.3)]">
              <p className="text-2xl font-semibold uppercase tracking-[0.08em]">Echo-Sight Demo Mode</p>
              <p className="mt-2 text-lg">Waiting for live camera stream on `{videoUrl}`</p>
            </div>
          )}

          {detections.map((detection, index) => {
            const [ymin, xmin, ymax, xmax] = detection.box
            return (
              <div
                key={`${detection.label}-${index}`}
                className="absolute border-[3px] border-[#27fff2] shadow-[0_0_16px_rgba(39,255,242,0.8)]"
                style={{
                  left: `${(xmin / 1000) * 100}%`,
                  top: `${(ymin / 1000) * 100}%`,
                  width: `${((xmax - xmin) / 1000) * 100}%`,
                  height: `${((ymax - ymin) / 1000) * 100}%`,
                }}
              >
                <span className="absolute -top-6 left-0 border border-[#27fff2] bg-[#003b37] px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#d6fffb]">
                  {detection.label}
                </span>
              </div>
            )
          })}
        </section>

        <aside className="flex flex-col gap-3">
          <Panel title="App Source">
            <p className="text-sm leading-7 text-[#c4fff8]">
              React UI is served on port {window.location.port || '5173'}.
            </p>
            <p className="text-sm leading-7 text-[#c4fff8]">
              Backend API/video/ws source:
              <br />
              {apiBase}
            </p>
            <div className="mt-3 flex items-center justify-between border-t border-[#0ad7cb66] pt-3">
              <span className="flex items-center gap-1 text-sm text-[#abfff4]">
                <User className="h-4 w-4" /> {username}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 border border-[#0ad7cb66] text-[#c8fff8] hover:bg-[#0ad7cb1a] hover:text-white"
                onClick={handleLogout}
              >
                <LogOut className="mr-2 h-3.5 w-3.5" />
                Logout
              </Button>
            </div>
          </Panel>

          <Panel title="Voice Prompt">
            <p className="min-h-[58px] text-3xl leading-tight text-[#d8fffb]">{voicePrompt}</p>
          </Panel>

          <Panel title="Haptic Intensity (0-255)">
            <p className="text-5xl text-[#8dfff4]">{hapticIntensity}</p>
            <div className="mt-3 h-6 overflow-hidden rounded-full border border-[#0ad7cb] bg-[#002c2f]">
              <div
                className="h-full bg-[linear-gradient(90deg,#fef5cb_0%,#f5de95_80%)] shadow-[0_0_20px_rgba(255,238,171,0.5)] transition-all duration-200"
                style={{ width: `${hapticPercent}%` }}
              />
            </div>
          </Panel>

          <Panel title="Detections">
            {detections.length === 0 ? (
              <p className="text-lg text-[#b7fef6]">No active obstacles</p>
            ) : (
              <div className="space-y-2">
                {detections.map((detection, index) => (
                  <p
                    key={`${detection.label}-${index}`}
                    className="rounded-md border border-[#0ad7cb66] bg-[#001f2acc] px-3 py-2 text-base text-[#d5fffb]"
                  >
                    {detection.label} :: [{detection.box.join(', ')}]
                  </p>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Event Log" className="flex-1">
            <div className="max-h-[270px] space-y-2 overflow-y-auto pr-1 text-sm text-[#9deee7]">
              {eventLog.length === 0 && <p>Waiting for websocket events...</p>}
              {eventLog.map((entry) => (
                <p key={entry.id} className="border-b border-[#0ad7cb33] pb-2">
                  <span className="text-[#7fd9d2]">[{entry.time}]</span> {entry.text}
                </p>
              ))}
            </div>
          </Panel>
        </aside>
      </div>
    </main>
  )
}
