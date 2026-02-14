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

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type LogEntry = { id: number; time: string; text: string }

const MAX_LOG = 120
const FRAME_INTERVAL_MS = 1000 // send 1 frame per second to Gemini
const USE_PI_CAMERA = true

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function apiBaseUrl() {
  const envBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim()
  if (envBase) return envBase.replace(/\/+$/, '')
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
  const host = window.location.hostname || '127.0.0.1'
  return `${protocol}//${host}:8010`
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
    <Card className={`border-white/10 bg-card ${className}`}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-white">
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

  const [connected, setConnected] = useState(false)
  const [cameraOn, setCameraOn] = useState(false)
  const [micOn, setMicOn] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [hasPiPreview, setHasPiPreview] = useState(false)
  const [eventLog, setEventLog] = useState<LogEntry[]>([])
  const [sessionActive, setSessionActive] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const piImageRef = useRef<HTMLImageElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const frameTimerRef = useRef<number | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const scriptNodeRef = useRef<ScriptProcessorNode | null>(null)
  const playerRef = useRef<ReturnType<typeof createPcmPlayer> | null>(null)
  const previewLoggedRef = useRef(false)

  const apiBase = useMemo(apiBaseUrl, [])
  const wsUrl = `${apiBase.replace(/^http/i, 'ws')}/ws/live?role=${USE_PI_CAMERA ? 'viewer' : 'source'}`

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
      console.log('[DEBUG] WS opened to', wsUrl)
    }

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string)

        if (msg.type === 'session_started') {
          setSessionActive(true)
          if (USE_PI_CAMERA) setCameraOn(true)
          addLog('Gemini Live session active')
        } else if (msg.type === 'viewer_connected') {
          console.log('[DEBUG] viewer_connected payload:', msg)
          if (USE_PI_CAMERA && msg.source_connected) {
            setCameraOn(true)
            addLog('Viewer attached to active Pi source')
          }
          if (msg.session_active) {
            setSessionActive(true)
            addLog('Gemini Live session already active')
          }
        } else if (msg.type === 'source_connected') {
          if (USE_PI_CAMERA) setCameraOn(true)
          addLog('Pi source connected')
        } else if (msg.type === 'source_disconnected') {
          if (USE_PI_CAMERA) {
            setCameraOn(false)
            setHasPiPreview(false)
            if (piImageRef.current) {
              piImageRef.current.src = ''
            }
            previewLoggedRef.current = false
          }
          setSessionActive(false)
          addLog('Pi source disconnected')
        } else if (msg.type === 'video_preview') {
          if (USE_PI_CAMERA) {
            if (piImageRef.current) {
              piImageRef.current.src = `data:image/jpeg;base64,${msg.data as string}`
            }
            if (!previewLoggedRef.current) {
              setHasPiPreview(true)
              addLog('Receiving Pi camera preview')
              previewLoggedRef.current = true
            }
          }
        } else if (msg.type === 'audio') {
          const raw = atob(msg.data as string)
          const buf = new ArrayBuffer(raw.length)
          const bytes = new Uint8Array(buf)
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
          if (!playerRef.current) playerRef.current = createPcmPlayer(24000)
          playerRef.current.feed(buf)
        } else if (msg.type === 'text') {
          setTranscript((p) => p + (msg.text as string))
          addLog(`Gemini: ${msg.text}`)
        } else if (msg.type === 'turn_complete') {
          setTranscript((p) => (p ? p + '\n' : p))
        } else if (msg.type === 'interrupted') {
          addLog('Gemini interrupted')
        } else if (msg.type === 'error') {
          addLog(`Error: ${msg.message}`)
        }
      } catch {
        addLog('Malformed WS message')
      }
    }

    socket.onclose = (ev) => {
      console.log('[DEBUG] WS closed  code=', ev.code, 'reason=', ev.reason, 'wasClean=', ev.wasClean)
      setConnected(false)
      setSessionActive(false)
      addLog('WebSocket disconnected')
    }
    socket.onerror = (ev) => {
      console.error('[DEBUG] WS error', ev)
      socket.close()
    }
  }, [wsUrl, addLog])

  useEffect(() => {
    if (!localStorage.getItem('token')) {
      navigate('/')
      return
    }
    connectWs()
    return () => {
      wsRef.current?.close()
    }
  }, [connectWs, navigate])

  /* ---------- Camera ---------- */
  const startCamera = useCallback(async () => {
    if (USE_PI_CAMERA) {
      setCameraOn(true)
      addLog('Pi camera mode enabled (browser camera disabled)')
      return
    }
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
    if (USE_PI_CAMERA) {
      setCameraOn(false)
      setHasPiPreview(false)
      if (piImageRef.current) {
        piImageRef.current.src = ''
      }
      previewLoggedRef.current = false
      addLog('Pi camera mode paused')
      return
    }
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
  useEffect(() => () => { playerRef.current?.stop() }, [])

  /* ---------- actions ---------- */
  const handleLogout = () => {
    stopCamera()
    stopMic()
    wsRef.current?.close()
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
    <main className="min-h-screen bg-background text-white">
      {/* Header */}
      <header className="border-b border-white/10 bg-background px-4 py-4 shadow-sm">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Glasses className="h-6 w-6 text-white" />
            <p className="text-xl font-bold italic tracking-tight text-white">VibeGlasses</p>
            <span className="ml-2 text-sm text-muted-foreground">Live</span>
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
              {connected ? (sessionActive ? 'Gemini Live' : 'Connected') : 'Disconnected'}
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

      {/* Body */}
      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-6 p-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* Video panel */}
        <section className="relative flex min-h-[70vh] flex-col overflow-hidden rounded-xl border border-white/10 bg-black shadow-lg">
          {USE_PI_CAMERA ? (
            <img
              ref={piImageRef}
              alt="Pi camera preview"
              className={`absolute inset-0 h-full w-full object-contain ${hasPiPreview ? '' : 'hidden'}`}
            />
          ) : (
            <video
              ref={videoRef}
              className="absolute inset-0 h-full w-full object-contain"
              autoPlay
              playsInline
              muted
            />
          )}
          <canvas ref={canvasRef} className="hidden" />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />

          {(!cameraOn || (USE_PI_CAMERA && !hasPiPreview)) && (
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-white/10 bg-background/95 px-8 py-6 text-center backdrop-blur-sm">
              <Camera className="mx-auto mb-3 h-12 w-12 text-white" />
              <p className="text-xl font-semibold text-white">{USE_PI_CAMERA ? 'Pi camera mode' : 'Camera is off'}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {USE_PI_CAMERA
                  ? 'Waiting for Raspberry Pi frames. Run pi_camera_client.py and keep source connected.'
                  : 'Click "Start Camera" to begin streaming to Gemini Live'}
              </p>
            </div>
          )}

          {/* Bottom controls */}
          <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-4 bg-black/60 px-6 py-4 backdrop-blur-sm">
            <Button
              onClick={cameraOn ? stopCamera : startCamera}
              className={`h-12 gap-2 px-6 text-sm font-semibold ${
                cameraOn
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'bg-white text-black hover:bg-white/90'
              }`}
            >
              {cameraOn ? <CameraOff className="h-5 w-5" /> : <Camera className="h-5 w-5" />}
              {cameraOn ? (USE_PI_CAMERA ? 'Stop Pi Camera Mode' : 'Stop Camera') : (USE_PI_CAMERA ? 'Use Pi Camera' : 'Start Camera')}
            </Button>
            <Button
              onClick={micOn ? stopMic : startMic}
              className={`h-12 gap-2 px-6 text-sm font-semibold ${
                micOn
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'bg-white text-black hover:bg-white/90'
              }`}
            >
              {micOn ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
              {micOn ? 'Mute Mic' : 'Start Mic'}
            </Button>
          </div>
        </section>

        {/* Right sidebar */}
        <aside className="flex flex-col gap-4">
          <Panel title="Connection" icon={<User className="h-4 w-4" />}>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                <span className="font-medium text-white">Backend:</span>{' '}
                <span className="text-xs">{apiBase}</span>
              </p>
              <p>
                <span className="font-medium text-white">Camera:</span>{' '}
                {cameraOn ? (USE_PI_CAMERA ? '🟢 Raspberry Pi source' : '🟢 streaming') : '⚫ off'}
              </p>
              <p>
                <span className="font-medium text-white">Mic:</span>{' '}
                {micOn ? '🟢 streaming' : '⚫ off'}
              </p>
              <p>
                <span className="font-medium text-white">Gemini:</span>{' '}
                {sessionActive ? '🟢 live session' : '⚫ not connected'}
              </p>
            </div>
          </Panel>

          <Panel title="Gemini Response" icon={<Volume2 className="h-4 w-4" />}>
            <div className="max-h-[200px] overflow-y-auto whitespace-pre-wrap text-sm text-white">
              {transcript || (
                <span className="text-muted-foreground">
                  Gemini audio responses play automatically. Text transcripts appear here.
                </span>
              )}
            </div>
            {transcript && (
              <Button
                variant="outline"
                size="sm"
                className="mt-2 border-white/10 text-xs"
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
                className="h-10 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-white placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              />
              <Button
                type="submit"
                className="h-10 bg-white text-sm font-semibold text-black hover:bg-white/90"
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
