import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Camera,
  CheckCircle2,
  LogOut,
  Play,
  User,
  Vibrate,
  Volume2,
  Wifi,
  WifiOff,
  Glasses,
  Activity,
  SlidersHorizontal,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

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

type VoiceCatalogItem = {
  voice_id: string
  name: string
}

type VoiceProfile = {
  voice_id: string
  stability: number
  clarity: number
  style_exaggeration: number
  playback_speed: number
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
    <Card className={`border-white/10 bg-card ${className}`}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-white">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {children}
      </CardContent>
    </Card>
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
  const [voices, setVoices] = useState<VoiceCatalogItem[]>([])
  const [selectedVoiceId, setSelectedVoiceId] = useState('')
  const [stability, setStability] = useState(0.5)
  const [clarity, setClarity] = useState(0.75)
  const [styleExaggeration, setStyleExaggeration] = useState(0.0)
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0)
  const [voiceStatus, setVoiceStatus] = useState('Voice profile sync pending...')
  const [voiceActionBusy, setVoiceActionBusy] = useState<string | null>(null)

  const apiBase = useMemo(apiBaseUrl, [])
  const videoUrl = `${apiBase}/stream/video`
  const videoStreamUrl = useMemo(() => `${videoUrl}?inline=1`, [videoUrl])
  const wsUrl = `${apiBase.replace(/^http/i, 'ws')}/stream/ws`
  const portLabel = window.location.port || '5173'
  const authToken = localStorage.getItem('token')
  const authHeaders = useMemo<Record<string, string>>(() => {
    const headers: Record<string, string> = {}
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`
    }
    return headers
  }, [authToken])

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
    if (!authToken) return

    const loadVoiceProfile = async () => {
      try {
        const [voicesRes, profileRes] = await Promise.all([
          fetch(`${apiBase}/voice-studio/voices`, { headers: authHeaders }),
          fetch(`${apiBase}/voice-studio/profile`, { headers: authHeaders }),
        ])
        if (!voicesRes.ok || !profileRes.ok) {
          setVoiceStatus('Voice profile API unavailable')
          return
        }

        const voicesPayload = (await voicesRes.json()) as { voices: VoiceCatalogItem[] }
        const profile = (await profileRes.json()) as VoiceProfile
        const nextVoices = voicesPayload.voices || []
        setVoices(nextVoices)
        setSelectedVoiceId(profile.voice_id || nextVoices[0]?.voice_id || '')
        setStability(profile.stability ?? 0.5)
        setClarity(profile.clarity ?? 0.75)
        setStyleExaggeration(profile.style_exaggeration ?? 0.0)
        setPlaybackSpeed(profile.playback_speed ?? 1.0)
        setVoiceStatus('Voice profile loaded')
      } catch {
        setVoiceStatus('Voice profile API unavailable')
      }
    }

    void loadVoiceProfile()
  }, [apiBase, authHeaders, authToken])

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

  const handleSaveVoiceProfile = async () => {
    if (!selectedVoiceId) {
      setVoiceStatus('Select a voice first')
      return
    }

    setVoiceActionBusy('save')
    try {
      const payload: VoiceProfile = {
        voice_id: selectedVoiceId,
        stability,
        clarity,
        style_exaggeration: styleExaggeration,
        playback_speed: playbackSpeed,
      }

      const response = await fetch(`${apiBase}/voice-studio/profile`, {
        method: 'PUT',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        throw new Error(`Save failed (${response.status})`)
      }
      setVoiceStatus('Voice profile saved')
      addLog('Voice profile saved')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save voice profile'
      setVoiceStatus(message)
      addLog(message)
    } finally {
      setVoiceActionBusy(null)
    }
  }

  const handlePreviewVoice = async () => {
    if (!selectedVoiceId) {
      setVoiceStatus('Select a voice first')
      return
    }

    setVoiceActionBusy('preview')
    try {
      const text = voicePrompt.trim() || 'Echo Sight preview'
      const response = await fetch(`${apiBase}/voice-studio/preview`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          voice_id: selectedVoiceId,
          stability,
          clarity,
          style_exaggeration: styleExaggeration,
          playback_speed: playbackSpeed,
          text,
        }),
      })

      if (response.status === 204) {
        setVoiceStatus('Preview unavailable (check key/quota)')
        return
      }
      if (!response.ok) {
        throw new Error(`Preview failed (${response.status})`)
      }

      const audio = new Audio(URL.createObjectURL(await response.blob()))
      await audio.play()
      setVoiceStatus('Preview playing')
      addLog('Voice preview playing')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Voice preview failed'
      setVoiceStatus(message)
      addLog(message)
    } finally {
      setVoiceActionBusy(null)
    }
  }

  const hapticPercent = Math.round((hapticIntensity / 255) * 100)

  return (
    <main className="min-h-screen bg-background text-white">
      <header className="border-b border-white/10 bg-background px-4 py-4 shadow-sm">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Glasses className="h-6 w-6 text-white" />
            <p className="text-xl font-bold italic tracking-tight text-white">
              VibeGlasses
            </p>
            <span className="ml-2 text-sm text-muted-foreground">
              Dashboard
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium ${
                connected 
                  ? 'border-green-500/20 bg-green-500/10 text-green-400' 
                  : 'border-red-500/20 bg-red-500/10 text-red-400'
              }`}
            >
              {connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
              {connected ? 'Connected' : 'Disconnected'}
            </span>
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <User className="h-4 w-4" />
              {username}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="border-white/10 hover:bg-white/5"
              onClick={() => navigate('/voice-studio')}
            >
              <SlidersHorizontal className="mr-2 h-4 w-4" />
              Voice Studio
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-white/10 hover:bg-white/5"
              onClick={handleLogout}
            >
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-6 p-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="relative min-h-[70vh] overflow-hidden rounded-xl border border-white/10 bg-black shadow-lg">
          <img
            src={videoStreamUrl}
            alt="Live camera feed"
            onLoad={() => setVideoReady(true)}
            onError={() => setVideoReady(false)}
            className="absolute inset-0 h-full w-full object-contain"
          />

          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />

          {!videoReady && (
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-white/10 bg-background/95 px-8 py-6 text-center backdrop-blur-sm">
              <Activity className="mx-auto mb-3 h-12 w-12 animate-pulse text-white" />
              <p className="text-xl font-semibold text-white">Waiting for camera feed</p>
              <p className="mt-2 text-sm text-muted-foreground">{videoUrl}</p>
            </div>
          )}

          {detections.map((detection, index) => {
            const [ymin, xmin, ymax, xmax] = detection.box
            return (
              <div
                key={`${detection.label}-${index}`}
                className="absolute border-2 border-white shadow-lg"
                style={{
                  left: `${(xmin / 1000) * 100}%`,
                  top: `${(ymin / 1000) * 100}%`,
                  width: `${((xmax - xmin) / 1000) * 100}%`,
                  height: `${((ymax - ymin) / 1000) * 100}%`,
                }}
              >
                <span className="absolute -top-6 left-0 rounded border border-white/20 bg-background px-2 py-0.5 text-xs font-semibold uppercase text-white backdrop-blur-sm">
                  {detection.label}
                </span>
              </div>
            )
          })}
        </section>

        <aside className="flex flex-col gap-4">
          <Panel title="Connection Info" icon={<User className="h-4 w-4" />}>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                <span className="font-medium text-white">Frontend:</span> Port {portLabel}
              </p>
              <p>
                <span className="font-medium text-white">Backend:</span>
                <br />
                <span className="text-xs">{apiBase}</span>
              </p>
            </div>
          </Panel>

          <Panel title="Hardware Controls" icon={<Vibrate className="h-4 w-4" />}>
            <div className="grid grid-cols-2 gap-2">
              <Button
                onClick={handleAnalyzeNow}
                disabled={actionBusy !== null}
                className="h-11 bg-white text-sm font-semibold text-black hover:bg-white/90"
              >
                <Camera className="mr-2 h-4 w-4" />
                Analyze Now
              </Button>
              <Button
                onClick={() => handleSpeakPrompt()}
                disabled={actionBusy !== null}
                className="h-11 bg-white text-sm font-semibold text-black hover:bg-white/90"
              >
                <Volume2 className="mr-2 h-4 w-4" />
                Speak
              </Button>
              <Button
                onClick={() => handleHapticPulse(120)}
                disabled={actionBusy !== null}
                variant="outline"
                className="h-11 border-white/10 text-sm font-semibold"
              >
                <Vibrate className="mr-2 h-4 w-4" />
                Pulse 120
              </Button>
              <Button
                onClick={() => handleHapticPulse(220)}
                disabled={actionBusy !== null}
                variant="outline"
                className="h-11 border-white/10 text-sm font-semibold"
              >
                <Vibrate className="mr-2 h-4 w-4" />
                Max Alert
              </Button>
            </div>
          </Panel>

          <Panel title="Voice Prompt" icon={<Volume2 className="h-4 w-4" />}>
            <p className="min-h-[48px] text-2xl font-semibold leading-tight text-white">
              {voicePrompt}
            </p>
          </Panel>

          <Panel title="Voice Customization" icon={<SlidersHorizontal className="h-4 w-4" />}>
            <div className="space-y-3">
              <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Voice
              </label>
              <select
                aria-label="Select voice"
                value={selectedVoiceId}
                onChange={(event) => setSelectedVoiceId(event.target.value)}
                className="h-10 w-full rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <option value="">Select voice</option>
                {voices.map((voice) => (
                  <option key={voice.voice_id} value={voice.voice_id}>
                    {voice.name}
                  </option>
                ))}
              </select>

              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">Stability {stability.toFixed(2)}</label>
                <input
                  aria-label="Stability slider"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={stability}
                  onChange={(event) => setStability(Number(event.target.value))}
                  className="w-full accent-white"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">Clarity {clarity.toFixed(2)}</label>
                <input
                  aria-label="Clarity slider"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={clarity}
                  onChange={(event) => setClarity(Number(event.target.value))}
                  className="w-full accent-white"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">
                  Style Exaggeration {styleExaggeration.toFixed(2)}
                </label>
                <input
                  aria-label="Style exaggeration slider"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={styleExaggeration}
                  onChange={(event) => setStyleExaggeration(Number(event.target.value))}
                  className="w-full accent-white"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">
                  Playback Speed {playbackSpeed.toFixed(2)}x
                </label>
                <input
                  aria-label="Playback speed slider"
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={playbackSpeed}
                  onChange={(event) => setPlaybackSpeed(Number(event.target.value))}
                  className="w-full accent-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Button
                  aria-label="Save voice profile"
                  onClick={handleSaveVoiceProfile}
                  disabled={voiceActionBusy !== null}
                  variant="outline"
                  className="h-10 border-white/10 text-sm"
                >
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  Save
                </Button>
                <Button
                  aria-label="Preview selected voice"
                  onClick={handlePreviewVoice}
                  disabled={voiceActionBusy !== null}
                  className="h-10 bg-white text-sm font-semibold text-black hover:bg-white/90"
                >
                  <Play className="mr-2 h-4 w-4" />
                  Preview
                </Button>
              </div>

              <p className="text-xs text-muted-foreground">{voiceStatus}</p>
            </div>
          </Panel>

          <Panel title="Haptic Intensity" icon={<Vibrate className="h-4 w-4" />}>
            <div className="space-y-3">
              <p className="text-4xl font-bold text-white">{hapticIntensity}</p>
              <div className="space-y-1">
                <div className="h-3 overflow-hidden rounded-full border border-white/10 bg-white/5">
                  <div
                    className="h-full bg-white transition-all duration-200"
                    style={{ width: `${hapticPercent}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">{hapticPercent}% intensity</p>
              </div>
            </div>
          </Panel>

          <Panel title="Detections" icon={<Camera className="h-4 w-4" />}>
            {detections.length === 0 ? (
              <p className="text-sm text-muted-foreground">No obstacles detected</p>
            ) : (
              <div className="space-y-2">
                {detections.map((detection, index) => (
                  <div
                    key={`${detection.label}-${index}`}
                    className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                    <p className="font-medium text-white">{detection.label}</p>
                    <p className="text-xs text-muted-foreground">
                      [{detection.box.join(', ')}]
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Activity Log" icon={<Activity className="h-4 w-4" />} className="flex-1">
            <div className="max-h-[280px] space-y-1.5 overflow-y-auto pr-1 text-xs">
              {eventLog.length === 0 && (
                <p className="text-muted-foreground">Waiting for events...</p>
              )}
              {eventLog.map((entry) => (
                <div key={entry.id} className="border-b border-white/5 pb-1.5">
                  <span className="font-medium text-muted-foreground">[{entry.time}]</span>
                  <span className="ml-2 text-white">{entry.text}</span>
                </div>
              ))}
            </div>
          </Panel>
        </aside>
      </div>
    </main>
  )
}
