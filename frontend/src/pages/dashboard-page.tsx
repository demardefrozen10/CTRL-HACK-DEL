import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ActivityHandling, GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai'
import {
  Camera,
  Glasses,
  LogOut,
  SlidersHorizontal,
  User,
  Volume2,
} from 'lucide-react'

import { Dashboard as DashboardSettings } from '@/components/Dashboard'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

type LogEntry = { id: number; time: string; text: string }
type VoiceProvider = 'gemini' | 'elevenlabs'
type VoiceProfile = {
  voice_id: string
  stability: number
  clarity: number
  style_exaggeration: number
  playback_speed: number
}

const MAX_LOG = 120
const FRAME_INTERVAL_MS = 500
const PROACTIVE_PROMPT_INTERVAL_MS = 4000
const MIC_BUFFER_SIZE = 1024
const GEMINI_MODEL =
  (import.meta.env.VITE_GEMINI_MODEL as string | undefined)?.trim() || 'gemini-2.5-flash-native-audio-latest'
const GEMINI_API_KEY = (import.meta.env.VITE_GEMINI_API_KEY as string | undefined)?.trim() || ''
const WAKE_PHRASE = 'hey sense'

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

function extractWakePhraseQuestion(text: string): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  const lower = normalized.toLowerCase()
  const idx = lower.indexOf(WAKE_PHRASE)
  if (idx < 0) return null
  const question = normalized.slice(idx + WAKE_PHRASE.length).trim().replace(/^[:,-]\s*/, '')
  return question || ''
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
  const [, setPiConnected] = useState(false)
  const [cameraOn, setCameraOn] = useState(true)
  const [micOn, setMicOn] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [hasPiPreview, setHasPiPreview] = useState(false)
  const [, setEventLog] = useState<LogEntry[]>([])
  const [, setSessionActive] = useState(false)
  const [voiceProvider, setVoiceProvider] = useState<VoiceProvider>('elevenlabs')
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfile | null>(null)

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
  const viewerReconnectAttemptsRef = useRef(0)
  const geminiReconnectAttemptsRef = useRef(0)
  const intentionalGeminiCloseRef = useRef(false)
  const geminiConnectedRef = useRef(false)
  const geminiConnectingRef = useRef(false)
  const voiceProfileRef = useRef<VoiceProfile | null>(null)
  const voiceProviderRef = useRef<VoiceProvider>('elevenlabs')
  const pendingTurnTextRef = useRef('')
  const elevenLabsPendingChunkRef = useRef('')
  const lastOutputTranscriptionRef = useRef('')
  const elevenLabsQueueRef = useRef<string[]>([])
  const elevenLabsSpeakingRef = useRef(false)
  const elevenLabsAudioRef = useRef<HTMLAudioElement | null>(null)
  const elevenLabsAudioUrlRef = useRef<string | null>(null)
  const lastWakeHandledRef = useRef('')
  const proactivePausedUntilRef = useRef(0)

  const apiBase = useMemo(apiBaseUrl, [])
  const backendWsUrl = `${apiBase.replace(/^http/i, 'ws')}/ws/live?role=viewer`

  const addLog = useCallback((text: string) => {
    setEventLog((prev) => {
      const entry: LogEntry = { id: Date.now() + Math.random(), time: now(), text }
      return [entry, ...prev].slice(0, MAX_LOG)
    })
  }, [])

  const stopPlaybackAndQueues = useCallback(() => {
    playerRef.current?.clear()
    if (elevenLabsAudioRef.current) {
      elevenLabsAudioRef.current.pause()
      elevenLabsAudioRef.current.currentTime = 0
    }
    elevenLabsQueueRef.current = []
    elevenLabsPendingChunkRef.current = ''
    pendingTurnTextRef.current = ''
    lastOutputTranscriptionRef.current = ''
  }, [])

  useEffect(() => {
    voiceProviderRef.current = voiceProvider
  }, [voiceProvider])

  useEffect(() => {
    voiceProfileRef.current = voiceProfile
  }, [voiceProfile])

  const loadVoiceProfile = useCallback(async () => {
    const token = localStorage.getItem('token')
    if (!token) return
    try {
      const response = await fetch(`${apiBase}/voice-studio/profile`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) {
        throw new Error(`profile status ${response.status}`)
      }
      const payload = (await response.json()) as VoiceProfile
      setVoiceProfile(payload)
    } catch (err) {
      addLog(`Voice profile unavailable: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [addLog, apiBase])

  const drainElevenLabsQueue = useCallback(async () => {
    if (elevenLabsSpeakingRef.current) return
    const next = elevenLabsQueueRef.current.shift()
    if (!next) return
    const profile = voiceProfileRef.current
    if (!profile) return

    const token = localStorage.getItem('token')
    if (!token) return

    elevenLabsSpeakingRef.current = true
    try {
      const response = await fetch(`${apiBase}/voice-studio/preview`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          voice_id: profile.voice_id,
          stability: profile.stability,
          clarity: profile.clarity,
          style_exaggeration: profile.style_exaggeration,
          playback_speed: profile.playback_speed,
          text: next,
        }),
      })
      if (!response.ok) {
        throw new Error(`status ${response.status}`)
      }
      const blob = await response.blob()
      if (elevenLabsAudioUrlRef.current) {
        URL.revokeObjectURL(elevenLabsAudioUrlRef.current)
      }
      const audioUrl = URL.createObjectURL(blob)
      elevenLabsAudioUrlRef.current = audioUrl
      const audio = new Audio(audioUrl)
      elevenLabsAudioRef.current = audio
      await audio.play()
      await new Promise<void>((resolve) => {
        audio.onended = () => resolve()
        audio.onerror = () => resolve()
      })
    } catch (err) {
      addLog(`ElevenLabs playback failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      elevenLabsSpeakingRef.current = false
      if (elevenLabsQueueRef.current.length > 0) {
        void drainElevenLabsQueue()
      }
    }
  }, [addLog, apiBase])

  const queueElevenLabsText = useCallback((raw: string) => {
    const text = raw.replace(/\s+/g, ' ').trim()
    if (!text) return
    elevenLabsQueueRef.current.push(text)
  }, [])

  const flushElevenLabsPendingChunk = useCallback(
    (force = false) => {
      const chunk = elevenLabsPendingChunkRef.current.trim()
      if (!chunk) return
      const hasBoundary = /[.!?]\s*$/.test(chunk)
      const longEnough = chunk.length >= 32
      if (!force && !hasBoundary && !longEnough) return
      queueElevenLabsText(chunk)
      elevenLabsPendingChunkRef.current = ''
      void drainElevenLabsQueue()
    },
    [drainElevenLabsQueue, queueElevenLabsText],
  )

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

  const safeSendInterruptingText = useCallback(
    (text: string) => {
      const session = sessionRef.current
      if (!session || !geminiConnectedRef.current) return false
      const wsReadyState = (session as { conn?: { ws?: { readyState?: number } } }).conn?.ws?.readyState
      if (typeof wsReadyState === 'number' && wsReadyState !== WebSocket.OPEN) {
        geminiConnectedRef.current = false
        setGeminiConnected(false)
        setSessionActive(false)
        return false
      }
      try {
        // Per Live API contract, client content interrupts ongoing generation.
        session.sendClientContent({ turns: text, turnComplete: true })
        return true
      } catch (err) {
        addLog(`Gemini interrupt send failed: ${err instanceof Error ? err.message : String(err)}`)
        return safeSendRealtimeInput({ text })
      }
    },
    [addLog, safeSendRealtimeInput],
  )

  const handleLiveMessage = useCallback(
    (msg: LiveServerMessage) => {
      if (msg.data) {
        if (voiceProviderRef.current === 'gemini') {
          if (!playerRef.current) playerRef.current = createPcmPlayer(24000)
          playerRef.current.feed(msg.data)
        }
      }

      if (msg.text) {
        setTranscript((p) => p + msg.text)
        addLog(`Gemini: ${msg.text}`)
        pendingTurnTextRef.current += msg.text
        if (voiceProviderRef.current === 'elevenlabs') {
          elevenLabsPendingChunkRef.current += msg.text
          flushElevenLabsPendingChunk(false)
        }
      }

      if (msg.serverContent?.inputTranscription?.text && msg.serverContent.inputTranscription.finished) {
        const spoken = msg.serverContent.inputTranscription.text
        addLog(`You: ${spoken}`)
        const wakeQuestion = extractWakePhraseQuestion(spoken)
        if (wakeQuestion !== null && spoken !== lastWakeHandledRef.current) {
          lastWakeHandledRef.current = spoken
          proactivePausedUntilRef.current = Date.now() + 12000
          stopPlaybackAndQueues()
          const questionText = wakeQuestion || 'Please answer my question now.'
          const sent = safeSendInterruptingText(
            `Stop speaking immediately and answer only this user question: ${questionText}`,
          )
          if (!sent) {
            safeSendRealtimeInput({ text: questionText })
          }
          addLog('Wake phrase detected: interrupting current speech and answering')
        }
      }

      if (
        msg.serverContent?.outputTranscription?.text
      ) {
        const transcribed = msg.serverContent.outputTranscription.text
        if (!msg.text && transcribed) {
          setTranscript((p) => p + transcribed)
        }
        if (voiceProviderRef.current === 'elevenlabs' && transcribed) {
          const previous = lastOutputTranscriptionRef.current
          const delta = transcribed.startsWith(previous) ? transcribed.slice(previous.length) : transcribed
          if (delta.trim()) {
            pendingTurnTextRef.current += delta
            elevenLabsPendingChunkRef.current += delta
            flushElevenLabsPendingChunk(false)
          }
          lastOutputTranscriptionRef.current = transcribed
        }
      }

      if (msg.serverContent?.interrupted) {
        playerRef.current?.clear()
        pendingTurnTextRef.current = ''
        if (elevenLabsAudioRef.current) {
          elevenLabsAudioRef.current.pause()
          elevenLabsAudioRef.current.currentTime = 0
        }
        addLog('Gemini interrupted')
      }

      if (msg.serverContent?.turnComplete) {
        if (voiceProviderRef.current === 'elevenlabs') {
          flushElevenLabsPendingChunk(true)
          const text = pendingTurnTextRef.current.trim()
          if (!text && elevenLabsQueueRef.current.length === 0 && !elevenLabsSpeakingRef.current) {
            addLog('ElevenLabs mode: no text available for TTS in this turn.')
          }
        }
        pendingTurnTextRef.current = ''
        elevenLabsPendingChunkRef.current = ''
        lastOutputTranscriptionRef.current = ''
        setTranscript((p) => (p ? `${p}\n` : p))
      }
    },
    [addLog, flushElevenLabsPendingChunk, safeSendInterruptingText, safeSendRealtimeInput, stopPlaybackAndQueues],
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
          /*
          realtimeInputConfig: {
            activityHandling: ActivityHandling.NO_INTERRUPTION,
          },
          */
          systemInstruction:
            "You are Sense, a real-time accessibility assistant for visually impaired users. You receive a live webcam video feed. Proactively describe what you see without waiting for the user to ask. Describe obstacles, hazards, objects, and surroundings in short, clear sentences (max 15 words). Use clock-position directions (e.g. 'Chair at 2 o\\'clock, 3 feet away'). Prioritize safety-critical objects first, then notable items. For example, if you see a bag of chips, say 'I see chips'. Speak naturally and calmly. Only switch to direct Q&A when the user explicitly starts with 'hey sense'. If the wake phrase is not used, do not switch into question-answer mode.",
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            if (!mountedRef.current) return
            geminiReconnectAttemptsRef.current = 0
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
              if (e.code === 1008 || e.code === 1002 || e.code === 1003 || e.code === 1007 || e.code === 1009) {
                addLog(`Gemini rejected session: ${e.reason || 'model/policy error'}`)
                return
              }
              if (geminiReconnectAttemptsRef.current >= 5) {
                addLog('Gemini reconnect limit reached. Refresh page after fixing config/network.')
                return
              }
              if (geminiReconnectTimerRef.current !== null) {
                clearTimeout(geminiReconnectTimerRef.current)
              }
              const attempt = geminiReconnectAttemptsRef.current
              const delayMs = Math.min(15000, 1200 * 2 ** attempt)
              geminiReconnectAttemptsRef.current += 1
              geminiReconnectTimerRef.current = window.setTimeout(() => {
                if (mountedRef.current && !sessionRef.current && !geminiConnectingRef.current) {
                  void connectGemini()
                }
              }, delayMs)
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
      viewerReconnectAttemptsRef.current = 0
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
      if (viewerReconnectAttemptsRef.current >= 10) {
        addLog('Backend relay reconnect limit reached. Check backend URL/port and refresh page.')
        return
      }
      if (viewerReconnectTimerRef.current !== null) {
        clearTimeout(viewerReconnectTimerRef.current)
      }
      const attempt = viewerReconnectAttemptsRef.current
      const delayMs = Math.min(15000, 1000 * 2 ** attempt)
      viewerReconnectAttemptsRef.current += 1
      viewerReconnectTimerRef.current = window.setTimeout(connectBackendViewer, delayMs)
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
    void loadVoiceProfile()

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
      if (elevenLabsAudioRef.current) {
        elevenLabsAudioRef.current.pause()
      }
      if (elevenLabsAudioUrlRef.current) {
        URL.revokeObjectURL(elevenLabsAudioUrlRef.current)
        elevenLabsAudioUrlRef.current = null
      }
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close()
      }
      wsRef.current = null
      disconnectGemini()
    }
  }, [connectBackendViewer, connectGemini, disconnectGemini, loadVoiceProfile, navigate])

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

  useEffect(() => {
    if (!cameraOn) return
    if (!geminiConnected) return

    const timer = window.setInterval(() => {
      if (Date.now() < proactivePausedUntilRef.current) return
      if (!latestPiFrameRef.current) return
      safeSendRealtimeInput({
        text: 'Give one short proactive mobility safety update for this view. Warn early if needed.',
      })
    }, PROACTIVE_PROMPT_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [cameraOn, geminiConnected, safeSendRealtimeInput])

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
    if (!localStorage.getItem('token')) return
    if (micOn) return
    void startMic()
  }, [micOn, startMic])

  useEffect(() => {
    return () => {
      playerRef.current?.stop()
      stopMic()
    }
  }, [stopMic])

  const handleLogout = () => {
    stopMic()
    stopPlaybackAndQueues()
    wsRef.current?.close()
    disconnectGemini()
    localStorage.removeItem('token')
    localStorage.removeItem('username')
    navigate('/')
  }

  const handleOpenVoiceStudio = () => {
    stopMic()
    stopPlaybackAndQueues()
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.close()
    }
    disconnectGemini()
    navigate('/voice-studio')
  }

  return (
    <main className="min-h-screen bg-background text-foreground" role="main" aria-label="SENSE live dashboard">
      <h1 className="sr-only">SENSE live dashboard</h1>
      {/* Header */}
      <header className="border-b border-border bg-background px-4 py-4 shadow-sm">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Glasses className="h-6 w-6 text-foreground" />
            <span className="sr-only">SENSE</span>
            <p aria-hidden="true" className="text-xl font-bold italic tracking-tight text-foreground">S.E.N.S.E.</p>
            <span className="ml-2 text-sm text-muted-foreground">Live</span>
          </div>

          <div className="flex items-center gap-3">
            {/* <span
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium ${
                geminiConnected
                  ? 'border-green-500/20 bg-green-500/10 text-green-400'
                  : 'border-red-500/20 bg-red-500/10 text-red-400'
              }`}
            >
              {geminiConnected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
              {geminiConnected ? 'Gemini Live' : 'Gemini Disconnected'}
            </span> */}
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <User className="h-4 w-4" />
              {username}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="border-border bg-background hover:bg-card"
              onClick={async () => {
                const next = voiceProvider === 'gemini' ? 'elevenlabs' : 'gemini'
                setVoiceProvider(next)
                if (next === 'elevenlabs' && !voiceProfile) {
                  await loadVoiceProfile()
                }
              }}
            >
              <Volume2 className="mr-2 h-4 w-4" />
              Voice: {voiceProvider === 'elevenlabs' ? 'ElevenLabs' : 'Gemini'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-border bg-background hover:bg-card"
              onClick={handleOpenVoiceStudio}
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

      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-6 p-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="relative flex aspect-video w-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-lg">
          <img
            ref={piImageRef}
            alt="Pi camera preview"
            className="absolute inset-0 h-full w-full object-contain"
          />

          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />

          {!hasPiPreview && (
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background px-8 py-6 text-center">
              <Camera className="mx-auto mb-3 h-12 w-12 text-foreground" />
              <p className="text-xl font-semibold text-foreground">Waiting for camera feed</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Waiting for Raspberry Pi frames from backend relay.
              </p>
            </div>
          )}
        </section>

        <aside className="flex flex-col gap-4">
          <DashboardSettings />

          {/* <Panel title="Connection" icon={<User className="h-4 w-4" />}>
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
          </Panel> */}

          <Panel title="Gemini Response" icon={<Volume2 className="h-4 w-4" />}>
            <div className="max-h-[200px] overflow-y-auto whitespace-pre-wrap text-sm text-foreground" role="log" aria-live="polite">
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

          {/* <Panel title="Send Message" icon={<MessageSquare className="h-4 w-4" />}>
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
                className="h-10 flex-1 rounded-lg border border-input bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
              />
              <Button
                type="submit"
                className="h-10 bg-foreground text-sm font-semibold text-background hover:opacity-90"
              >
                Send
              </Button>
            </form>
          </Panel> */}

          {/* <Panel title="Activity Log" icon={<Activity className="h-4 w-4" />} className="flex-1">
            <div className="max-h-[320px] space-y-1.5 overflow-y-auto pr-1 text-xs">
              {eventLog.length === 0 && <p className="text-muted-foreground">Waiting for events...</p>}
              {eventLog.map((entry) => (
                <div key={entry.id} className="border-b border-border pb-1.5">
                  <span className="font-medium text-muted-foreground">[{entry.time}]</span>
                  <span className="ml-2 text-foreground">{entry.text}</span>
                </div>
              ))}
            </div>
          </Panel> */}
        </aside>
      </div>
    </main>
  )
}
