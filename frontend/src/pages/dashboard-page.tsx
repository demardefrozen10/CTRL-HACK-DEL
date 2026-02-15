import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai'
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

type LogEntry = { id: number; time: string; text: string }

const MAX_LOG = 120
const USE_PI_CAMERA = true
const FRAME_INTERVAL_MS = 500
const MIC_BUFFER_SIZE = 1024
const GEMINI_MODEL =
  (import.meta.env.VITE_GEMINI_MODEL as string | undefined)?.trim() || 'gemini-2.5-flash-native-audio-latest'
const GEMINI_API_KEY = (import.meta.env.VITE_GEMINI_API_KEY as string | undefined)?.trim() || ''

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
    feed(base64Audio: string) {
      const raw = atob(base64Audio)
      const buf = new ArrayBuffer(raw.length)
      const bytes = new Uint8Array(buf)
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)

      const view = new DataView(buf)
      const samples = new Float32Array(buf.byteLength / 2)
      for (let i = 0; i < samples.length; i++) {
        samples[i] = view.getInt16(i * 2, true) / 32768
      }
      queue.push(samples)
    },
    clear() {
      queue.length = 0
      currentChunk = null
      offset = 0
    },
    stop() {
      processor.disconnect()
      void audioCtx.close()
    },
  }
}

function float32ToBase64Pcm16(float32: Float32Array) {
  const int16 = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  const bytes = new Uint8Array(int16.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function createMicWorkletModuleUrl(bufferSize: number): string {
  const source = `
class PCMInputProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.bufferSize = options?.processorOptions?.bufferSize || ${bufferSize};
    this.buffer = new Float32Array(this.bufferSize);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];
    let i = 0;
    while (i < channel.length) {
      const remaining = this.bufferSize - this.offset;
      const toCopy = Math.min(remaining, channel.length - i);
      this.buffer.set(channel.subarray(i, i + toCopy), this.offset);
      this.offset += toCopy;
      i += toCopy;
      if (this.offset >= this.bufferSize) {
        const out = new Float32Array(this.buffer);
        this.port.postMessage(out.buffer, [out.buffer]);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-input-processor', PCMInputProcessor);
`
  return URL.createObjectURL(new Blob([source], { type: 'application/javascript' }))
}

export function DashboardPage() {
  const navigate = useNavigate()
  const username = localStorage.getItem('username') || 'User'

  const [geminiConnected, setGeminiConnected] = useState(false)
  const [piConnected, setPiConnected] = useState(false)
  const [cameraOn, setCameraOn] = useState(false)
  const [micOn, setMicOn] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [hasPiPreview, setHasPiPreview] = useState(false)
  const [eventLog, setEventLog] = useState<LogEntry[]>([])
  const [sessionActive, setSessionActive] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const piImageRef = useRef<HTMLImageElement>(null)
  const latestPiFrameRef = useRef<string>('')
  const micStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const micWorkletRef = useRef<AudioWorkletNode | null>(null)
  const playerRef = useRef<ReturnType<typeof createPcmPlayer> | null>(null)
  const sessionRef = useRef<Session | null>(null)
  const mountedRef = useRef(false)
  const viewerReconnectTimerRef = useRef<number | null>(null)
  const geminiReconnectTimerRef = useRef<number | null>(null)
  const intentionalGeminiCloseRef = useRef(false)
  const geminiConnectedRef = useRef(false)
  const geminiConnectingRef = useRef(false)

  const apiBase = useMemo(apiBaseUrl, [])
  const backendWsUrl = `${apiBase.replace(/^http/i, 'ws')}/ws/live?role=viewer`

  const addLog = useCallback((text: string) => {
    setEventLog((prev) => {
      const entry: LogEntry = { id: Date.now() + Math.random(), time: now(), text }
      return [entry, ...prev].slice(0, MAX_LOG)
    })
  }, [])

  const safeSendRealtimeInput = useCallback(
    (payload: Parameters<Session['sendRealtimeInput']>[0]) => {
      const session = sessionRef.current
      if (!session || !geminiConnectedRef.current) return false
      const wsReadyState = (session as { conn?: { ws?: { readyState?: number } } }).conn?.ws?.readyState
      if (typeof wsReadyState === 'number' && wsReadyState !== WebSocket.OPEN) {
        console.log('[Gemini] disconnected: socket readyState is not OPEN', wsReadyState)
        geminiConnectedRef.current = false
        setGeminiConnected(false)
        setSessionActive(false)
        return false
      }
      try {
        session.sendRealtimeInput(payload)
        return true
      } catch (err) {
        console.log('[Gemini] disconnected: sendRealtimeInput failed', err)
        addLog(`Gemini socket send failed: ${err instanceof Error ? err.message : String(err)}`)
        sessionRef.current = null
        geminiConnectedRef.current = false
        setGeminiConnected(false)
        setSessionActive(false)
        return false
      }
    },
    [addLog],
  )

  const handleLiveMessage = useCallback(
    (msg: LiveServerMessage) => {
      if (msg.data) {
        if (!playerRef.current) playerRef.current = createPcmPlayer(24000)
        playerRef.current.feed(msg.data)
      }

      if (msg.text) {
        setTranscript((p) => p + msg.text)
        addLog(`Gemini: ${msg.text}`)
      }

      if (msg.serverContent?.inputTranscription?.text && msg.serverContent.inputTranscription.finished) {
        addLog(`You: ${msg.serverContent.inputTranscription.text}`)
      }

      if (
        msg.serverContent?.outputTranscription?.text &&
        msg.serverContent.outputTranscription.finished &&
        !msg.text
      ) {
        setTranscript((p) => p + msg.serverContent!.outputTranscription!.text!)
      }

      if (msg.serverContent?.interrupted) {
        playerRef.current?.clear()
        addLog('Gemini interrupted')
      }

      if (msg.serverContent?.turnComplete) {
        setTranscript((p) => (p ? `${p}\n` : p))
      }
    },
    [addLog],
  )

  const connectGemini = useCallback(async () => {
    if (sessionRef.current || geminiConnectingRef.current) return
    if (!GEMINI_API_KEY) {
      addLog('Missing VITE_GEMINI_API_KEY in frontend/.env')
      return
    }

    try {
      geminiConnectingRef.current = true
      const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY, apiVersion: 'v1beta' })
      const session = await ai.live.connect({
        model: GEMINI_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction:
            'You are Echo-Sight, a live multimodal assistant. Use video and speech. Keep responses concise unless asked for detail.',
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            if (!mountedRef.current) return
            geminiConnectedRef.current = true
            setGeminiConnected(true)
            setSessionActive(true)
            addLog(`Gemini Live connected (${GEMINI_MODEL})`)
          },
          onmessage: handleLiveMessage,
          onerror: (e) => {
            console.log('[Gemini] disconnected: onerror', e)
            geminiConnectedRef.current = false
            setGeminiConnected(false)
            setSessionActive(false)
            addLog(`Gemini error: ${e.message || 'unknown error'}`)
          },
          onclose: (e) => {
            console.log('[Gemini] disconnected: onclose', {
              code: e.code,
              reason: e.reason,
              wasClean: e.wasClean,
            })
            geminiConnectedRef.current = false
            sessionRef.current = null
            if (!mountedRef.current) return
            setGeminiConnected(false)
            setSessionActive(false)
            addLog('Gemini Live disconnected')
            if (!intentionalGeminiCloseRef.current) {
              if (e.code === 1008) {
                addLog(`Gemini rejected session: ${e.reason || 'model/policy error'}`)
                return
              }
              if (geminiReconnectTimerRef.current !== null) {
                clearTimeout(geminiReconnectTimerRef.current)
              }
              geminiReconnectTimerRef.current = window.setTimeout(() => {
                if (mountedRef.current && !sessionRef.current && !geminiConnectingRef.current) {
                  void connectGemini()
                }
              }, 1200)
            }
          },
        },
      })
      if (!mountedRef.current) {
        session.close()
        return
      }
      sessionRef.current = session
    } catch (err) {
      addLog(`Failed to connect Gemini Live: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      geminiConnectingRef.current = false
    }
  }, [addLog, handleLiveMessage])

  const connectBackendViewer = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return

    const socket = new WebSocket(backendWsUrl)
    wsRef.current = socket

    socket.onopen = () => {
      setPiConnected(true)
      addLog('Connected to backend relay')
    }

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string)

        if (msg.type === 'viewer_connected') {
          if (msg.source_connected) {
            setCameraOn(true)
            addLog('Pi source already connected')
          }
        } else if (msg.type === 'source_connected') {
          setCameraOn(true)
          addLog('Pi source connected')
        } else if (msg.type === 'source_disconnected') {
          setCameraOn(false)
          setHasPiPreview(false)
          latestPiFrameRef.current = ''
          if (piImageRef.current) piImageRef.current.src = ''
          addLog('Pi source disconnected')
        } else if (msg.type === 'video_preview') {
          const b64 = String(msg.data || '')
          if (!b64) return
          latestPiFrameRef.current = b64
          if (piImageRef.current) {
            piImageRef.current.src = `data:image/jpeg;base64,${b64}`
          }
          setHasPiPreview(true)
        } else if (msg.type === 'error') {
          addLog(`Relay error: ${msg.message}`)
        }
      } catch {
        addLog('Malformed relay message')
      }
    }

    socket.onclose = () => {
      setPiConnected(false)
      addLog('Backend relay disconnected')
      wsRef.current = null
      if (!mountedRef.current) return
      if (viewerReconnectTimerRef.current !== null) {
        clearTimeout(viewerReconnectTimerRef.current)
      }
      viewerReconnectTimerRef.current = window.setTimeout(connectBackendViewer, 1500)
    }

    socket.onerror = () => {
      socket.close()
    }
  }, [addLog, backendWsUrl])

  const disconnectGemini = useCallback(() => {
    intentionalGeminiCloseRef.current = true
    if (geminiReconnectTimerRef.current !== null) {
      clearTimeout(geminiReconnectTimerRef.current)
      geminiReconnectTimerRef.current = null
    }
    geminiConnectedRef.current = false
    sessionRef.current?.close()
    sessionRef.current = null
    setGeminiConnected(false)
    setSessionActive(false)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    intentionalGeminiCloseRef.current = false
    if (!localStorage.getItem('token')) {
      navigate('/')
      return
    }

    connectBackendViewer()
    void connectGemini()

    return () => {
      mountedRef.current = false
      if (viewerReconnectTimerRef.current !== null) {
        clearTimeout(viewerReconnectTimerRef.current)
        viewerReconnectTimerRef.current = null
      }
      if (geminiReconnectTimerRef.current !== null) {
        clearTimeout(geminiReconnectTimerRef.current)
        geminiReconnectTimerRef.current = null
      }
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close()
      }
      wsRef.current = null
      disconnectGemini()
    }
  }, [connectBackendViewer, connectGemini, disconnectGemini, navigate])

  useEffect(() => {
    if (!cameraOn) return

    const timer = window.setInterval(() => {
      const b64 = latestPiFrameRef.current
      if (!b64) return
      safeSendRealtimeInput({
        video: {
          mimeType: 'image/jpeg',
          data: b64,
        },
      })
    }, FRAME_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [cameraOn, safeSendRealtimeInput])

  const startCamera = useCallback(() => {
    if (!USE_PI_CAMERA) return
    setCameraOn(true)
    addLog('Pi camera forwarding enabled')
  }, [addLog])

  const stopCamera = useCallback(() => {
    setCameraOn(false)
    addLog('Pi camera forwarding paused')
  }, [addLog])

  const startMic = useCallback(async () => {
    try {
      if (!sessionRef.current) {
        await connectGemini()
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true },
      })
      micStreamRef.current = stream

      const audioCtx = new AudioContext({ sampleRate: 16000 })
      audioContextRef.current = audioCtx
      await audioCtx.resume()
      const source = audioCtx.createMediaStreamSource(stream)
      micSourceRef.current = source

      const moduleUrl = createMicWorkletModuleUrl(MIC_BUFFER_SIZE)
      await audioCtx.audioWorklet.addModule(moduleUrl)
      URL.revokeObjectURL(moduleUrl)

      const worklet = new AudioWorkletNode(audioCtx, 'pcm-input-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        processorOptions: { bufferSize: MIC_BUFFER_SIZE },
      })
      micWorkletRef.current = worklet

      worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        const float32 = new Float32Array(e.data)
        safeSendRealtimeInput({
          audio: {
            mimeType: 'audio/pcm;rate=16000',
            data: float32ToBase64Pcm16(float32),
          },
        })
      }

      source.connect(worklet)

      setMicOn(true)
      addLog('Microphone started (16 kHz PCM)')
    } catch (err) {
      addLog(`Mic error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [addLog, connectGemini, safeSendRealtimeInput])

  const stopMic = useCallback(() => {
    micWorkletRef.current?.disconnect()
    micWorkletRef.current = null
    micSourceRef.current?.disconnect()
    micSourceRef.current = null
    void audioContextRef.current?.close()
    audioContextRef.current = null
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    micStreamRef.current = null
    setMicOn(false)
    addLog('Microphone stopped')
    safeSendRealtimeInput({ audioStreamEnd: true })
  }, [addLog, safeSendRealtimeInput])

  useEffect(() => {
    return () => {
      playerRef.current?.stop()
      stopMic()
    }
  }, [stopMic])

  const handleLogout = () => {
    stopMic()
    wsRef.current?.close()
    disconnectGemini()
    localStorage.removeItem('token')
    localStorage.removeItem('username')
    navigate('/')
  }

  const handleSendText = (text: string) => {
    if (!sessionRef.current) return
    sessionRef.current.sendClientContent({ turns: text, turnComplete: true })
    addLog(`You: ${text}`)
  }

  return (
    <main className="min-h-screen bg-background text-white">
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
                geminiConnected
                  ? 'border-green-500/20 bg-green-500/10 text-green-400'
                  : 'border-red-500/20 bg-red-500/10 text-red-400'
              }`}
            >
              {geminiConnected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
              {geminiConnected ? 'Gemini Live' : 'Gemini Disconnected'}
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
        <section className="relative flex min-h-[70vh] flex-col overflow-hidden rounded-xl border border-white/10 bg-black shadow-lg">
          <img
            ref={piImageRef}
            alt="Pi camera preview"
            className={`absolute inset-0 h-full w-full object-contain ${hasPiPreview ? '' : 'hidden'}`}
          />

          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />

          {(!cameraOn || !hasPiPreview) && (
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-white/10 bg-background/95 px-8 py-6 text-center backdrop-blur-sm">
              <Camera className="mx-auto mb-3 h-12 w-12 text-white" />
              <p className="text-xl font-semibold text-white">Pi camera mode</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Waiting for Raspberry Pi frames from backend relay.
              </p>
            </div>
          )}

          <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-4 bg-black/60 px-6 py-4 backdrop-blur-sm">
            <Button
              onClick={cameraOn ? stopCamera : startCamera}
              className={`h-12 gap-2 px-6 text-sm font-semibold ${
                cameraOn ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-white text-black hover:bg-white/90'
              }`}
            >
              {cameraOn ? <CameraOff className="h-5 w-5" /> : <Camera className="h-5 w-5" />}
              {cameraOn ? 'Pause Pi Forwarding' : 'Start Pi Forwarding'}
            </Button>
            <Button
              onClick={micOn ? stopMic : startMic}
              className={`h-12 gap-2 px-6 text-sm font-semibold ${
                micOn ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-white text-black hover:bg-white/90'
              }`}
            >
              {micOn ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
              {micOn ? 'Mute Mic' : 'Start Mic'}
            </Button>
          </div>
        </section>

        <aside className="flex flex-col gap-4">
          <Panel title="Connection" icon={<User className="h-4 w-4" />}>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                <span className="font-medium text-white">Backend Relay:</span> <span className="text-xs">{apiBase}</span>
              </p>
              <p>
                <span className="font-medium text-white">Pi Relay WS:</span> {piConnected ? 'ON' : 'OFF'}
              </p>
              <p>
                <span className="font-medium text-white">Pi Camera:</span> {cameraOn ? 'forwarding' : 'paused'}
              </p>
              <p>
                <span className="font-medium text-white">Mic:</span> {micOn ? 'ON' : 'OFF'}
              </p>
              <p>
                <span className="font-medium text-white">Gemini:</span> {sessionActive ? 'LIVE' : 'DISCONNECTED'}
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
                const input = (e.target as HTMLFormElement).elements.namedItem('msg') as HTMLInputElement
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
              <Button type="submit" className="h-10 bg-white text-sm font-semibold text-black hover:bg-white/90">
                Send
              </Button>
            </form>
          </Panel>

          <Panel title="Activity Log" icon={<Activity className="h-4 w-4" />} className="flex-1">
            <div className="max-h-[320px] space-y-1.5 overflow-y-auto pr-1 text-xs">
              {eventLog.length === 0 && <p className="text-muted-foreground">Waiting for events...</p>}
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
