import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Camera,
  CameraOff,
  Glasses,
  LogOut,
  Mic,
  MicOff,
  SlidersHorizontal,
  User,
  Wifi,
  WifiOff,
  Activity,
  MessageSquare,
  Volume2,
} from 'lucide-react'

import { Dashboard as DashboardSettings } from '@/components/Dashboard'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type LogEntry = { id: number; time: string; text: string }
type VoiceProvider = 'gemini' | 'elevenlabs'

const MAX_LOG = 120
const FRAME_INTERVAL_MS = 1000 // send 1 frame per second to Gemini

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function apiBaseUrl() {
  const envBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim()
  if (envBase) return envBase.replace(/\/+$/, '')
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
  const host = window.location.hostname || '127.0.0.1'
  return `${protocol}//${host}:8000`
}

function now() {
  return new Date().toLocaleTimeString()
}

function Panel({
  title,
  icon,
  children,
  className = '',
}: {
  title: string
  icon?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-muted-foreground">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  PCM audio playback (24 kHz 16-bit signed LE from Gemini)           */
/* ------------------------------------------------------------------ */

function createPcmPlayer(sampleRate = 24000) {
  const audioCtx = new AudioContext({ sampleRate })
  const queue: Float32Array[] = []
  let offset = 0
  let currentChunk: Float32Array | null = null

  const processor = audioCtx.createScriptProcessor(4096, 1, 1)
  processor.onaudioprocess = (e) => {
    const output = e.outputBuffer.getChannelData(0)
    let i = 0
    while (i < output.length) {
      if (!currentChunk || offset >= currentChunk.length) {
        currentChunk = queue.shift() ?? null
        offset = 0
      }
      if (!currentChunk) {
        output[i++] = 0
        continue
      }
      output[i++] = currentChunk[offset++]
    }
  }
  processor.connect(audioCtx.destination)

  return {
    feed(pcmBytes: ArrayBuffer) {
      const view = new DataView(pcmBytes)
      const samples = new Float32Array(pcmBytes.byteLength / 2)
      for (let i = 0; i < samples.length; i++) {
        samples[i] = view.getInt16(i * 2, true) / 32768
      }
      queue.push(samples)
    },
    stop() {
      processor.disconnect()
      void audioCtx.close()
    },
  }
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function DashboardPage() {
  const navigate = useNavigate()
  const username = localStorage.getItem('username') || 'User'
  const token = localStorage.getItem('token') || ''

  const [connected, setConnected] = useState(false)
  const [cameraOn, setCameraOn] = useState(false)
  const [micOn, setMicOn] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [eventLog, setEventLog] = useState<LogEntry[]>([])
  const [sessionActive, setSessionActive] = useState(false)
  const [voiceProvider, setVoiceProvider] = useState<VoiceProvider>('elevenlabs')
  const [voiceCustomizationEnabled, setVoiceCustomizationEnabled] = useState(true)

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const frameTimerRef = useRef<number | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const scriptNodeRef = useRef<ScriptProcessorNode | null>(null)
  const playerRef = useRef<ReturnType<typeof createPcmPlayer> | null>(null)
  const mp3AudioRef = useRef<HTMLAudioElement | null>(null)
  const mp3AudioUrlRef = useRef<string | null>(null)
  const shouldReconnectRef = useRef(true)
  const reconnectTimerRef = useRef<number | null>(null)

  const apiBase = useMemo(apiBaseUrl, [])
  const wsUrl = useMemo(() => {
    const base = `${apiBase.replace(/^http/i, 'ws')}/ws/live`
    if (!token) return base
    return `${base}?token=${encodeURIComponent(token)}`
  }, [apiBase, token])

  /* ---------- logging ---------- */
  const addLog = useCallback((text: string) => {
    setEventLog((prev) => {
      const entry: LogEntry = { id: Date.now() + Math.random(), time: now(), text }
      return [entry, ...prev].slice(0, MAX_LOG)
    })
  }, [])

  /* ---------- WebSocket ---------- */
  const connectWs = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return

    const socket = new WebSocket(wsUrl)
    wsRef.current = socket

    socket.onopen = () => {
      setConnected(true)
      addLog('WebSocket connected')
    }

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string)

        if (msg.type === 'session_started') {
          setSessionActive(true)
          addLog('Gemini Live session active')
        } else if (msg.type === 'settings_ack') {
          const nextProvider = msg.voice_provider
          if (typeof msg.voice_customization_enabled === 'boolean') {
            setVoiceCustomizationEnabled(msg.voice_customization_enabled)
          }
          addLog(`Voice provider: ${nextProvider === 'elevenlabs' ? 'ElevenLabs custom' : 'Gemini native'}`)
        } else if (msg.type === 'audio') {
          const raw = atob(msg.data as string)
          const buf = new ArrayBuffer(raw.length)
          const bytes = new Uint8Array(buf)
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
          if (!playerRef.current) playerRef.current = createPcmPlayer(24000)
          playerRef.current.feed(buf)
        } else if (msg.type === 'audio_mp3') {
          const raw = atob(msg.data as string)
          const bytes = new Uint8Array(raw.length)
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
          if (mp3AudioRef.current) {
            mp3AudioRef.current.pause()
          }
          if (mp3AudioUrlRef.current) {
            URL.revokeObjectURL(mp3AudioUrlRef.current)
          }
          const blob = new Blob([bytes], { type: 'audio/mpeg' })
          const url = URL.createObjectURL(blob)
          mp3AudioUrlRef.current = url
          const audio = new Audio(url)
          mp3AudioRef.current = audio
          void audio.play()
        } else if (msg.type === 'text') {
          const chunk = String(msg.text ?? '').trim()
          if (chunk) {
            setTranscript((prev) => {
              if (!prev) return chunk
              const needsSpace = !/[\s\n]$/.test(prev) && !/^[,.;:!?)]/.test(chunk)
              return `${prev}${needsSpace ? ' ' : ''}${chunk}`
            })
          }
          addLog(`Gemini: ${msg.text}`)
        } else if (msg.type === 'turn_complete') {
          setTranscript((p) => (p ? p + '\n' : p))
        } else if (msg.type === 'interrupted') {
          addLog('Gemini interrupted')
        } else if (msg.type === 'error') {
          addLog(`Error: ${msg.message}`)
        } else if (msg.type === 'warning') {
          addLog(`Warning: ${msg.message}`)
        }
      } catch {
        addLog('Malformed WS message')
      }
    }

    socket.onclose = () => {
      setConnected(false)
      setSessionActive(false)
      addLog('WebSocket disconnected')
      if (shouldReconnectRef.current) {
        if (reconnectTimerRef.current) {
          window.clearTimeout(reconnectTimerRef.current)
        }
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null
          connectWs()
        }, 1500)
      }
    }
    socket.onerror = () => socket.close()
  }, [wsUrl, addLog])

  useEffect(() => {
    if (!token) {
      navigate('/')
      return
    }
    shouldReconnectRef.current = true
    connectWs()
    return () => {
      shouldReconnectRef.current = false
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      wsRef.current?.close()
    }
  }, [connectWs, navigate, token])

  useEffect(() => {
    if (!connected || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    wsRef.current.send(JSON.stringify({ type: 'settings', voice_provider: voiceProvider }))
    addLog(`Requested voice provider: ${voiceProvider === 'elevenlabs' ? 'ElevenLabs custom' : 'Gemini native'}`)
  }, [voiceProvider, connected, addLog])

  /* ---------- Camera ---------- */
  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: 640, height: 480 },
        audio: false,
      })
      cameraStreamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setCameraOn(true)
      addLog('Camera started')

      const canvas = canvasRef.current!
      const ctx = canvas.getContext('2d')!
      frameTimerRef.current = window.setInterval(() => {
        if (
          !videoRef.current ||
          !wsRef.current ||
          wsRef.current.readyState !== WebSocket.OPEN
        )
          return
        canvas.width = 640
        canvas.height = 480
        ctx.drawImage(videoRef.current, 0, 0, 640, 480)
        const b64 = canvas.toDataURL('image/jpeg', 0.6).split(',')[1]
        wsRef.current.send(JSON.stringify({ type: 'video', data: b64 }))
      }, FRAME_INTERVAL_MS)
    } catch (err) {
      addLog(`Camera error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [addLog])

  const stopCamera = useCallback(() => {
    if (frameTimerRef.current) {
      clearInterval(frameTimerRef.current)
      frameTimerRef.current = null
    }
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop())
    cameraStreamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setCameraOn(false)
    addLog('Camera stopped')
  }, [addLog])

  /* ---------- Microphone ---------- */
  const startMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true },
      })
      micStreamRef.current = stream

      const audioCtx = new AudioContext({ sampleRate: 16000 })
      audioContextRef.current = audioCtx
      const source = audioCtx.createMediaStreamSource(stream)

      const scriptNode = audioCtx.createScriptProcessor(4096, 1, 1)
      scriptNodeRef.current = scriptNode

      scriptNode.onaudioprocess = (e) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
        const float32 = e.inputBuffer.getChannelData(0)
        const int16 = new Int16Array(float32.length)
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]))
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
        }
        const bytes = new Uint8Array(int16.buffer)
        let binary = ''
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
        const b64 = btoa(binary)
        wsRef.current.send(JSON.stringify({ type: 'audio', data: b64 }))
      }

      source.connect(scriptNode)
      scriptNode.connect(audioCtx.destination)

      setMicOn(true)
      addLog('Microphone started (16 kHz PCM)')
    } catch (err) {
      addLog(`Mic error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [addLog])

  const stopMic = useCallback(() => {
    scriptNodeRef.current?.disconnect()
    scriptNodeRef.current = null
    void audioContextRef.current?.close()
    audioContextRef.current = null
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    micStreamRef.current = null
    setMicOn(false)
    addLog('Microphone stopped')
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'end_audio_stream' }))
    }
  }, [addLog])

  /* ---------- cleanup ---------- */
  useEffect(
    () => () => {
      playerRef.current?.stop()
      mp3AudioRef.current?.pause()
      if (mp3AudioUrlRef.current) {
        URL.revokeObjectURL(mp3AudioUrlRef.current)
      }
    },
    [],
  )

  /* ---------- actions ---------- */
  const handleLogout = () => {
    shouldReconnectRef.current = false
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    stopCamera()
    stopMic()
    wsRef.current?.close()
    mp3AudioRef.current?.pause()
    localStorage.removeItem('token')
    localStorage.removeItem('username')
    navigate('/')
  }

  const handleSendText = (text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    wsRef.current.send(JSON.stringify({ type: 'text', text }))
    addLog(`You: ${text}`)
  }

  /* ---------- render ---------- */
  return (
    <main className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-background px-4 py-4 shadow-sm">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Glasses className="h-6 w-6 text-foreground" />
            <p className="text-xl font-bold italic tracking-tight text-foreground">S.E.N.S.E.</p>
            <span className="ml-2 text-sm text-muted-foreground">Live</span>
          </div>

          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground">
              {connected ? (
                <Wifi className="h-3.5 w-3.5 text-accent" />
              ) : (
                <WifiOff className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              {connected ? (sessionActive ? 'Gemini Live' : 'Connected') : 'Disconnected'}
            </span>
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <User className="h-4 w-4" />
              {username}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="border-border bg-background hover:bg-card"
              onClick={() =>
                setVoiceProvider((current) => (current === 'gemini' ? 'elevenlabs' : 'gemini'))
              }
            >
              <Volume2 className="mr-2 h-4 w-4" />
              Voice: {voiceProvider === 'elevenlabs' ? 'ElevenLabs' : 'Gemini'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-border bg-background hover:bg-card"
              onClick={() => navigate('/voice-studio')}
            >
              <SlidersHorizontal className="mr-2 h-4 w-4" />
              Voice Studio
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-border bg-background hover:bg-card"
              onClick={handleLogout}
            >
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </Button>
          </div>
        </div>
      </header>

      {/* Body */}
      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-6 p-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* Video panel */}
        <section className="relative flex min-h-[70vh] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-lg">
          <video
            ref={videoRef}
            className="absolute inset-0 h-full w-full object-contain"
            autoPlay
            playsInline
            muted
          />
          <canvas ref={canvasRef} className="hidden" />

          {!cameraOn && (
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background px-8 py-6 text-center">
              <Camera className="mx-auto mb-3 h-12 w-12 text-foreground" />
              <p className="text-xl font-semibold text-foreground">Camera is off</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Click &ldquo;Start Camera&rdquo; to begin streaming to Gemini&nbsp;Live
              </p>
            </div>
          )}

          {/* Bottom controls */}
          <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-4 border-t border-border bg-background px-6 py-4">
            <Button
              onClick={cameraOn ? stopCamera : startCamera}
              className={`h-12 gap-2 px-6 text-sm font-semibold ${
                cameraOn
                  ? 'bg-destructive text-destructive-foreground hover:opacity-90'
                  : 'bg-foreground text-background hover:opacity-90'
              }`}
            >
              {cameraOn ? <CameraOff className="h-5 w-5" /> : <Camera className="h-5 w-5" />}
              {cameraOn ? 'Stop Camera' : 'Start Camera'}
            </Button>
            <Button
              onClick={micOn ? stopMic : startMic}
              className={`h-12 gap-2 px-6 text-sm font-semibold ${
                micOn
                  ? 'bg-destructive text-destructive-foreground hover:opacity-90'
                  : 'bg-foreground text-background hover:opacity-90'
              }`}
            >
              {micOn ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
              {micOn ? 'Mute Mic' : 'Start Mic'}
            </Button>
          </div>
        </section>

        {/* Right sidebar */}
        <aside className="flex flex-col gap-4">
          <DashboardSettings />

          <Panel title="Connection" icon={<User className="h-4 w-4" />}>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">Backend:</span>{' '}
                <span className="text-xs">{apiBase}</span>
              </p>
              <p>
                <span className="font-medium text-foreground">Camera:</span>{' '}
                {cameraOn ? '🟢 streaming' : '⚫ off'}
              </p>
              <p>
                <span className="font-medium text-foreground">Mic:</span>{' '}
                {micOn ? '🟢 streaming' : '⚫ off'}
              </p>
              <p>
                <span className="font-medium text-foreground">Gemini:</span>{' '}
                {sessionActive ? '🟢 live session' : '⚫ not connected'}
              </p>
              <p>
                <span className="font-medium text-foreground">Voice Output:</span>{' '}
                {voiceProvider === 'elevenlabs' ? '🟢 ElevenLabs custom' : '🟢 Gemini native'}
              </p>
              <p>
                <span className="font-medium text-foreground">Voice Profile:</span>{' '}
                {voiceCustomizationEnabled ? '🟢 linked to your account' : '⚫ login token missing'}
              </p>
            </div>
          </Panel>

          <Panel title="Gemini Response" icon={<Volume2 className="h-4 w-4" />}>
            <div className="max-h-[200px] overflow-y-auto whitespace-pre-wrap text-sm text-foreground">
              {transcript || (
                <span className="text-muted-foreground">
                  {voiceProvider === 'elevenlabs'
                    ? 'ElevenLabs custom voice plays automatically. Transcripts appear here.'
                    : 'Gemini native audio plays automatically. Transcripts appear here.'}
                </span>
              )}
            </div>
            {transcript && (
              <Button
                variant="outline"
                size="sm"
                className="mt-2 border-border bg-background text-xs hover:bg-card"
                onClick={() => setTranscript('')}
              >
                Clear
              </Button>
            )}
          </Panel>

          <Panel title="Send Message" icon={<MessageSquare className="h-4 w-4" />}>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                const input = (e.target as HTMLFormElement).elements.namedItem(
                  'msg',
                ) as HTMLInputElement
                const text = input.value.trim()
                if (text) {
                  handleSendText(text)
                  input.value = ''
                }
              }}
            >
              <input
                name="msg"
                type="text"
                placeholder="Type a message to Gemini..."
                className="h-10 flex-1 rounded-lg border border-input bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
              />
              <Button
                type="submit"
                className="h-10 bg-foreground text-sm font-semibold text-background hover:opacity-90"
              >
                Send
              </Button>
            </form>
          </Panel>

          <Panel title="Activity Log" icon={<Activity className="h-4 w-4" />} className="flex-1">
            <div className="max-h-[320px] space-y-1.5 overflow-y-auto pr-1 text-xs">
              {eventLog.length === 0 && (
                <p className="text-muted-foreground">Waiting for events...</p>
              )}
              {eventLog.map((entry) => (
                <div key={entry.id} className="border-b border-border pb-1.5">
                  <span className="font-medium text-muted-foreground">[{entry.time}]</span>
                  <span className="ml-2 text-foreground">{entry.text}</span>
                </div>
              ))}
            </div>
          </Panel>
        </aside>
      </div>
    </main>
  )
}
