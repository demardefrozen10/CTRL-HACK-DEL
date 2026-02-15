import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, CheckCircle2, Filter, SlidersHorizontal, Volume2 } from 'lucide-react'

import { Button } from '@/components/ui/button'

type VoiceItem = {
  voice_id: string
  name: string
  category: string
  preview_url?: string | null
  quality: string
  gender: string
  age: string
  notice_period: string
  custom_rates?: boolean | null
  live_moderation?: boolean | null
  descriptive?: string | null
}

type VoiceProfile = {
  voice_id: string
  stability: number
  clarity: number
  style_exaggeration: number
  playback_speed: number
}

type VoiceCapabilities = {
  models: string[]
  output_formats: string[]
  optimize_streaming_latency: string[]
  text_normalization: string[]
  defaults: {
    model_id?: string
    output_format?: string
    optimize_streaming_latency?: string
    use_speaker_boost?: boolean
    apply_text_normalization?: string
  }
}

type InclusionFilter = 'any' | 'include' | 'exclude'

type Filters = {
  quality: 'any' | 'hq'
  gender: 'any' | 'male' | 'female' | 'neutral'
  age: 'any' | 'young' | 'middle_aged' | 'old'
  notice_period: 'any' | '30d' | '90d' | '1y'
  custom_rates: InclusionFilter
  live_moderation: InclusionFilter
}

function apiBaseUrl() {
  const envBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim()
  if (envBase) return envBase.replace(/\/+$/, '')
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
  const host = window.location.hostname || '127.0.0.1'
  return `${protocol}//${host}:8000`
}

function inclusionMatches(value: boolean | null | undefined, mode: InclusionFilter) {
  if (mode === 'any') return true
  if (mode === 'include') return value === true
  return value !== true
}

function prettyLabel(value: string) {
  if (value === 'middle_aged') return 'Middle Aged'
  if (value === '30d') return '30d'
  if (value === '90d') return '90d'
  if (value === '1y') return '1y'
  if (value === 'hq') return 'HQ'
  return value.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter((value) => Boolean(value))))
}

export function VoiceStudioPage() {
  const navigate = useNavigate()
  const apiBase = useMemo(apiBaseUrl, [])
  const statusRegionRef = useRef<HTMLDivElement | null>(null)

  const [voices, setVoices] = useState<VoiceItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState('Loading voice studio...')
  const [selectedVoiceId, setSelectedVoiceId] = useState('')
  const [previewText, setPreviewText] = useState(
    "Obstacle ahead, slight left. You're moving safely.",
  )

  const [stability, setStability] = useState(0.5)
  const [clarity, setClarity] = useState(0.75)
  const [styleExaggeration, setStyleExaggeration] = useState(0.0)
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0)
  const [capabilities, setCapabilities] = useState<VoiceCapabilities | null>(null)
  const [modelId, setModelId] = useState('eleven_flash_v2_5')
  const [stsModelId, setStsModelId] = useState('eleven_multilingual_sts_v2')
  const [outputFormat, setOutputFormat] = useState('mp3_22050_32')
  const [optimizeStreamingLatency, setOptimizeStreamingLatency] = useState('4')
  const [textNormalization, setTextNormalization] = useState<'auto' | 'on' | 'off'>('auto')
  const [useSpeakerBoost, setUseSpeakerBoost] = useState(true)
  const [enableLogging, setEnableLogging] = useState(true)
  const [streamPreview, setStreamPreview] = useState(true)
  const [languageCode, setLanguageCode] = useState('')
  const [seedInput, setSeedInput] = useState('')
  const [transformFile, setTransformFile] = useState<File | null>(null)
  const [effectText, setEffectText] = useState('soft warning beep')
  const [dubbingSourceUrl, setDubbingSourceUrl] = useState('')
  const [dubbingTargetLang, setDubbingTargetLang] = useState('en')
  const [dubbingSourceLang, setDubbingSourceLang] = useState('')
  const [toolBusy, setToolBusy] = useState<'none' | 's2s' | 'changer' | 'sfx' | 'dubbing'>('none')
  const [lastDubbingResult, setLastDubbingResult] = useState<Record<string, unknown> | null>(null)
  const lastAudioUrlRef = useRef<string | null>(null)

  const [filters, setFilters] = useState<Filters>({
    quality: 'any',
    gender: 'any',
    age: 'any',
    notice_period: 'any',
    custom_rates: 'any',
    live_moderation: 'any',
  })

  const authToken = localStorage.getItem('token')

  const announce = useCallback((message: string) => {
    setStatusMessage(message)
    window.setTimeout(() => statusRegionRef.current?.focus(), 0)
  }, [])

  const authHeaders = useMemo<Record<string, string>>(() => {
    const headers: Record<string, string> = {}
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`
    }
    return headers
  }, [authToken])

  useEffect(
    () => () => {
      if (lastAudioUrlRef.current) {
        URL.revokeObjectURL(lastAudioUrlRef.current)
      }
    },
    [],
  )

  useEffect(() => {
    if (!authToken) {
      navigate('/')
      return
    }

    const load = async () => {
      setLoading(true)
      try {
        const [voicesRes, profileRes, capabilitiesRes] = await Promise.all([
          fetch(`${apiBase}/voice-studio/voices`, { headers: authHeaders }),
          fetch(`${apiBase}/voice-studio/profile`, { headers: authHeaders }),
          fetch(`${apiBase}/voice-studio/capabilities`, { headers: authHeaders }),
        ])

        if (!voicesRes.ok) {
          throw new Error(`Could not load voices (${voicesRes.status})`)
        }
        if (!profileRes.ok) {
          throw new Error(`Could not load profile (${profileRes.status})`)
        }

        const voicesPayload = (await voicesRes.json()) as { voices: VoiceItem[] }
        const profilePayload = (await profileRes.json()) as VoiceProfile
        let capabilitiesPayload: VoiceCapabilities | null = null
        if (capabilitiesRes.ok) {
          capabilitiesPayload = (await capabilitiesRes.json()) as VoiceCapabilities
        }

        setVoices(voicesPayload.voices || [])
        setSelectedVoiceId(profilePayload.voice_id || voicesPayload.voices?.[0]?.voice_id || '')
        setStability(profilePayload.stability ?? 0.5)
        setClarity(profilePayload.clarity ?? 0.75)
        setStyleExaggeration(profilePayload.style_exaggeration ?? 0.0)
        setPlaybackSpeed(profilePayload.playback_speed ?? 1.0)
        setCapabilities(capabilitiesPayload)

        if (capabilitiesPayload?.defaults) {
          if (capabilitiesPayload.defaults.model_id) setModelId(capabilitiesPayload.defaults.model_id)
          if (capabilitiesPayload.defaults.output_format) setOutputFormat(capabilitiesPayload.defaults.output_format)
          if (capabilitiesPayload.defaults.optimize_streaming_latency) {
            setOptimizeStreamingLatency(capabilitiesPayload.defaults.optimize_streaming_latency)
          }
          if (capabilitiesPayload.defaults.apply_text_normalization) {
            const nextMode = capabilitiesPayload.defaults.apply_text_normalization
            if (nextMode === 'auto' || nextMode === 'on' || nextMode === 'off') {
              setTextNormalization(nextMode)
            }
          }
          if (typeof capabilitiesPayload.defaults.use_speaker_boost === 'boolean') {
            setUseSpeakerBoost(capabilitiesPayload.defaults.use_speaker_boost)
          }
        }
        announce('Voice Studio loaded. All controls are keyboard accessible.')
      } catch (error) {
        announce(error instanceof Error ? error.message : 'Failed to load voice studio')
      } finally {
        setLoading(false)
      }
    }

    void load()
  }, [announce, apiBase, authHeaders, authToken, navigate])

  const filteredVoices = useMemo(() => {
    return voices.filter((voice) => {
      if (filters.quality !== 'any' && voice.quality !== filters.quality) return false
      if (filters.gender !== 'any' && voice.gender !== filters.gender) return false
      if (filters.age !== 'any' && voice.age !== filters.age) return false
      if (filters.notice_period !== 'any' && voice.notice_period !== filters.notice_period) return false
      if (!inclusionMatches(voice.custom_rates, filters.custom_rates)) return false
      if (!inclusionMatches(voice.live_moderation, filters.live_moderation)) return false
      return true
    })
  }, [filters, voices])

  const selectedVoice = useMemo(
    () => voices.find((voice) => voice.voice_id === selectedVoiceId) || null,
    [selectedVoiceId, voices],
  )

  const currentProfile: VoiceProfile = useMemo(
    () => ({
      voice_id: selectedVoiceId,
      stability,
      clarity,
      style_exaggeration: styleExaggeration,
      playback_speed: playbackSpeed,
    }),
    [clarity, playbackSpeed, selectedVoiceId, stability, styleExaggeration],
  )

  const modelOptions = useMemo(
    () =>
      uniqueStrings([
        ...(capabilities?.models || []),
        'eleven_flash_v2_5',
        'eleven_turbo_v2_5',
        'eleven_multilingual_v2',
      ]),
    [capabilities],
  )

  const outputFormatOptions = useMemo(
    () =>
      uniqueStrings([
        ...(capabilities?.output_formats || []),
        'mp3_22050_32',
        'mp3_44100_64',
        'mp3_44100_128',
        'pcm_16000',
        'pcm_22050',
      ]),
    [capabilities],
  )

  const latencyOptions = useMemo(
    () =>
      uniqueStrings([...(capabilities?.optimize_streaming_latency || []), '0', '1', '2', '3', '4']),
    [capabilities],
  )

  const textNormalizationOptions = useMemo(
    () =>
      uniqueStrings([...(capabilities?.text_normalization || []), 'auto', 'on', 'off']).filter(
        (value) => value === 'auto' || value === 'on' || value === 'off',
      ),
    [capabilities],
  )

  const saveProfile = async () => {
    if (!selectedVoiceId) {
      announce('Select a voice before saving.')
      return
    }
    setSaving(true)
    try {
      const response = await fetch(`${apiBase}/voice-studio/profile`, {
        method: 'PUT',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(currentProfile),
      })
      if (!response.ok) {
        throw new Error(`Save failed (${response.status})`)
      }
      announce(`Saved voice profile: ${selectedVoice?.name ?? selectedVoiceId}`)
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Failed to save voice profile')
    } finally {
      setSaving(false)
    }
  }

  const previewVoice = async (voiceId: string) => {
    if (!voiceId) return
    setPreviewingVoiceId(voiceId)
    try {
      const payload: Record<string, unknown> = {
        ...currentProfile,
        voice_id: voiceId,
        text: previewText.trim() || 'S.E.N.S.E. voice preview.',
        model_id: modelId,
        output_format: outputFormat,
        optimize_streaming_latency: optimizeStreamingLatency,
        use_speaker_boost: useSpeakerBoost,
        apply_text_normalization: textNormalization,
        enable_logging: enableLogging,
        stream: streamPreview,
      }
      if (languageCode.trim()) payload.language_code = languageCode.trim()
      if (seedInput.trim()) {
        const parsedSeed = Number(seedInput.trim())
        if (Number.isInteger(parsedSeed)) {
          payload.seed = parsedSeed
        }
      }

      const response = await fetch(`${apiBase}/voice-studio/preview`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      if (response.status === 204) {
        announce('Preview unavailable. Check ElevenLabs API key or quota.')
        return
      }
      if (!response.ok) {
        throw new Error(`Preview failed (${response.status})`)
      }
      const audioBlob = await response.blob()
      if (lastAudioUrlRef.current) {
        URL.revokeObjectURL(lastAudioUrlRef.current)
      }
      const audioUrl = URL.createObjectURL(audioBlob)
      lastAudioUrlRef.current = audioUrl
      const audio = new Audio(audioUrl)
      await audio.play()
      announce(`Playing preview for ${voices.find((v) => v.voice_id === voiceId)?.name ?? voiceId}`)
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Voice preview failed')
    } finally {
      setPreviewingVoiceId(null)
    }
  }

  const readErrorDetail = async (response: Response) => {
    try {
      const payload = (await response.json()) as { detail?: unknown; message?: unknown }
      if (typeof payload.detail === 'string') return payload.detail
      if (payload.detail) return JSON.stringify(payload.detail)
      if (typeof payload.message === 'string') return payload.message
    } catch {
      // ignore parse errors and fall back to generic text
    }
    return `Request failed (${response.status})`
  }

  const buildTransformFormData = (removeBackgroundNoise: boolean) => {
    if (!transformFile) {
      throw new Error('Choose an audio file first.')
    }
    if (!selectedVoiceId) {
      throw new Error('Select a voice first.')
    }
    const formData = new FormData()
    formData.append('audio', transformFile)
    formData.append('voice_id', selectedVoiceId)
    formData.append('model_id', stsModelId)
    formData.append('output_format', outputFormat)
    formData.append('optimize_streaming_latency', optimizeStreamingLatency)
    formData.append('enable_logging', String(enableLogging))
    formData.append('stream', String(streamPreview))
    formData.append('stability', String(stability))
    formData.append('clarity', String(clarity))
    formData.append('style_exaggeration', String(styleExaggeration))
    formData.append('playback_speed', String(playbackSpeed))
    formData.append('use_speaker_boost', String(useSpeakerBoost))
    formData.append('remove_background_noise', String(removeBackgroundNoise))
    if (seedInput.trim()) {
      const parsedSeed = Number(seedInput.trim())
      if (Number.isInteger(parsedSeed)) {
        formData.append('seed', String(parsedSeed))
      }
    }
    return formData
  }

  const runTransformTool = async (mode: 's2s' | 'changer') => {
    const endpoint = mode === 's2s' ? 'speech-to-speech' : 'voice-changer'
    const label = mode === 's2s' ? 'speech-to-speech' : 'voice changer'
    setToolBusy(mode)
    try {
      const response = await fetch(`${apiBase}/elevenlabs/${endpoint}`, {
        method: 'POST',
        headers: authHeaders,
        body: buildTransformFormData(mode === 'changer'),
      })
      if (!response.ok) {
        throw new Error(await readErrorDetail(response))
      }
      const audioBlob = await response.blob()
      if (lastAudioUrlRef.current) {
        URL.revokeObjectURL(lastAudioUrlRef.current)
      }
      const audioUrl = URL.createObjectURL(audioBlob)
      lastAudioUrlRef.current = audioUrl
      const audio = new Audio(audioUrl)
      await audio.play()
      announce(`Playing ${label} output.`)
    } catch (error) {
      announce(error instanceof Error ? error.message : `Failed to run ${label}.`)
    } finally {
      setToolBusy('none')
    }
  }

  const runSoundEffects = async () => {
    setToolBusy('sfx')
    try {
      const response = await fetch(`${apiBase}/elevenlabs/sound-effects`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: effectText.trim() || 'soft warning beep',
        }),
      })
      if (!response.ok) {
        throw new Error(await readErrorDetail(response))
      }
      const audioBlob = await response.blob()
      if (lastAudioUrlRef.current) {
        URL.revokeObjectURL(lastAudioUrlRef.current)
      }
      const audioUrl = URL.createObjectURL(audioBlob)
      lastAudioUrlRef.current = audioUrl
      const audio = new Audio(audioUrl)
      await audio.play()
      announce('Playing generated sound effect.')
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Sound effect generation failed.')
    } finally {
      setToolBusy('none')
    }
  }

  const runDubbing = async () => {
    setToolBusy('dubbing')
    try {
      if (!dubbingSourceUrl.trim()) {
        throw new Error('Add a source media URL for dubbing.')
      }
      const formData = new FormData()
      formData.append('target_lang', dubbingTargetLang.trim() || 'en')
      formData.append('source_url', dubbingSourceUrl.trim())
      if (dubbingSourceLang.trim()) {
        formData.append('source_lang', dubbingSourceLang.trim())
      }
      formData.append('name', `EchoSight-${new Date().toISOString()}`)

      const response = await fetch(`${apiBase}/elevenlabs/dubbing`, {
        method: 'POST',
        headers: authHeaders,
        body: formData,
      })
      if (!response.ok) {
        throw new Error(await readErrorDetail(response))
      }
      const payload = (await response.json()) as Record<string, unknown>
      setLastDubbingResult(payload)
      const dubbingId = typeof payload.dubbing_id === 'string' ? payload.dubbing_id : ''
      announce(dubbingId ? `Dubbing created: ${dubbingId}` : 'Dubbing request submitted.')
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Dubbing request failed.')
    } finally {
      setToolBusy('none')
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-background px-6 py-4 shadow-sm">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              S.E.N.S.E.
            </p>
            <h1 className="text-2xl font-semibold text-foreground">Voice Studio</h1>
          </div>
          <Button
            aria-label="Back to dashboard"
            onClick={() => navigate('/dashboard')}
            variant="outline"
            size="sm"
            className="h-11 px-5"
          >
            <ArrowLeft className="mr-2 h-5 w-5" aria-hidden="true" />
            Back to Dashboard
          </Button>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-6 p-6 lg:grid-cols-[24rem_minmax(0,1fr)]">
        <section className="space-y-6 rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <Filter className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-lg font-semibold text-foreground">Voice Filters</h2>
          </div>

          <fieldset className="space-y-3">
            <legend className="sr-only">Voice metadata filters</legend>

            <label htmlFor="quality-filter" className="block text-sm font-medium text-muted-foreground">
              Quality
            </label>
            <select
              id="quality-filter"
              aria-label="Filter voices by quality"
              value={filters.quality}
              onChange={(event) => setFilters((current) => ({ ...current, quality: event.target.value as Filters['quality'] }))}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
            >
              <option value="any">Any</option>
              <option value="hq">HQ</option>
            </select>

            <label htmlFor="gender-filter" className="block text-sm font-medium text-muted-foreground">
              Gender
            </label>
            <select
              id="gender-filter"
              aria-label="Filter voices by gender"
              value={filters.gender}
              onChange={(event) => setFilters((current) => ({ ...current, gender: event.target.value as Filters['gender'] }))}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
            >
              <option value="any">Any</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="neutral">Neutral</option>
            </select>

            <label htmlFor="age-filter" className="block text-sm font-medium text-muted-foreground">
              Age
            </label>
            <select
              id="age-filter"
              aria-label="Filter voices by age"
              value={filters.age}
              onChange={(event) => setFilters((current) => ({ ...current, age: event.target.value as Filters['age'] }))}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
            >
              <option value="any">Any</option>
              <option value="young">Young</option>
              <option value="middle_aged">Middle Aged</option>
              <option value="old">Old</option>
            </select>

            <label htmlFor="notice-filter" className="block text-sm font-medium text-muted-foreground">
              Notice Period
            </label>
            <select
              id="notice-filter"
              aria-label="Filter voices by notice period"
              value={filters.notice_period}
              onChange={(event) =>
                setFilters((current) => ({ ...current, notice_period: event.target.value as Filters['notice_period'] }))
              }
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
            >
              <option value="any">Any</option>
              <option value="30d">30d</option>
              <option value="90d">90d</option>
              <option value="1y">1y</option>
            </select>

            <label
              htmlFor="custom-rates-filter"
              className="block text-sm font-medium text-muted-foreground"
            >
              Custom Rates
            </label>
            <select
              id="custom-rates-filter"
              aria-label="Filter voices by custom rates support"
              value={filters.custom_rates}
              onChange={(event) =>
                setFilters((current) => ({ ...current, custom_rates: event.target.value as InclusionFilter }))
              }
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
            >
              <option value="any">Any</option>
              <option value="include">Include</option>
              <option value="exclude">Exclude</option>
            </select>

            <label
              htmlFor="live-moderation-filter"
              className="block text-sm font-medium text-muted-foreground"
            >
              Live Moderation
            </label>
            <select
              id="live-moderation-filter"
              aria-label="Filter voices by live moderation support"
              value={filters.live_moderation}
              onChange={(event) =>
                setFilters((current) => ({ ...current, live_moderation: event.target.value as InclusionFilter }))
              }
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
            >
              <option value="any">Any</option>
              <option value="include">Include</option>
              <option value="exclude">Exclude</option>
            </select>
          </fieldset>

          <div className="space-y-4 border-t border-border pt-6">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
              <h3 className="text-base font-semibold text-foreground">Voice Tuning</h3>
            </div>

            <label
              htmlFor="stability-slider"
              className="block text-sm font-medium text-muted-foreground"
            >
              Stability: {stability.toFixed(2)}
            </label>
            <input
              id="stability-slider"
              aria-label="Stability slider"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={stability}
              onChange={(event) => setStability(Number(event.target.value))}
              className="w-full accent-[var(--accent)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
            />

            <label htmlFor="clarity-slider" className="block text-sm font-medium text-muted-foreground">
              Clarity: {clarity.toFixed(2)}
            </label>
            <input
              id="clarity-slider"
              aria-label="Clarity slider"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={clarity}
              onChange={(event) => setClarity(Number(event.target.value))}
              className="w-full accent-[var(--accent)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
            />

            <label htmlFor="style-slider" className="block text-sm font-medium text-muted-foreground">
              Style Exaggeration: {styleExaggeration.toFixed(2)}
            </label>
            <input
              id="style-slider"
              aria-label="Style exaggeration slider"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={styleExaggeration}
              onChange={(event) => setStyleExaggeration(Number(event.target.value))}
              className="w-full accent-[var(--accent)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
            />

            <label htmlFor="speed-slider" className="block text-sm font-medium text-muted-foreground">
              Playback Speed: {playbackSpeed.toFixed(2)}x
            </label>
            <input
              id="speed-slider"
              aria-label="Playback speed slider"
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={playbackSpeed}
              onChange={(event) => setPlaybackSpeed(Number(event.target.value))}
              className="w-full accent-[var(--accent)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
            />
          </div>

          <div className="space-y-4 border-t border-border pt-6">
            <h3 className="text-base font-semibold text-foreground">ElevenLabs Advanced</h3>

            <label htmlFor="model-id" className="block text-sm font-medium text-muted-foreground">
              Model
            </label>
            <select
              id="model-id"
              aria-label="ElevenLabs model selection"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
            >
              {modelOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>

            <label
              htmlFor="output-format"
              className="block text-sm font-medium text-muted-foreground"
            >
              Output Format
            </label>
            <select
              id="output-format"
              aria-label="ElevenLabs output audio format"
              value={outputFormat}
              onChange={(event) => setOutputFormat(event.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
            >
              {outputFormatOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>

            <label
              htmlFor="latency-setting"
              className="block text-sm font-medium text-muted-foreground"
            >
              Optimize Streaming Latency
            </label>
            <select
              id="latency-setting"
              aria-label="ElevenLabs optimize streaming latency level"
              value={optimizeStreamingLatency}
              onChange={(event) => setOptimizeStreamingLatency(event.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
            >
              {latencyOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>

            <label
              htmlFor="text-normalization"
              className="block text-sm font-medium text-muted-foreground"
            >
              Text Normalization
            </label>
            <select
              id="text-normalization"
              aria-label="ElevenLabs text normalization mode"
              value={textNormalization}
              onChange={(event) => {
                const value = event.target.value
                if (value === 'auto' || value === 'on' || value === 'off') {
                  setTextNormalization(value)
                }
              }}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
            >
              {textNormalizationOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>

            <label
              htmlFor="language-code"
              className="block text-sm font-medium text-muted-foreground"
            >
              Language Code (Optional)
            </label>
            <input
              id="language-code"
              aria-label="Optional language code for ElevenLabs synthesis"
              type="text"
              value={languageCode}
              onChange={(event) => setLanguageCode(event.target.value)}
              placeholder="en"
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
            />

            <label htmlFor="seed-input" className="block text-sm font-medium text-muted-foreground">
              Seed (Optional, integer)
            </label>
            <input
              id="seed-input"
              aria-label="Optional deterministic seed for ElevenLabs synthesis"
              type="number"
              value={seedInput}
              onChange={(event) => setSeedInput(event.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
            />

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  aria-label="Enable speaker boost for ElevenLabs voice"
                  type="checkbox"
                  checked={useSpeakerBoost}
                  onChange={(event) => setUseSpeakerBoost(event.target.checked)}
                  className="h-4 w-4 rounded border border-input bg-background accent-[var(--accent)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
                />
                Speaker Boost
              </label>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  aria-label="Enable ElevenLabs request logging"
                  type="checkbox"
                  checked={enableLogging}
                  onChange={(event) => setEnableLogging(event.target.checked)}
                  className="h-4 w-4 rounded border border-input bg-background accent-[var(--accent)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
                />
                API Logging
              </label>
              <label className="flex items-center gap-2 text-sm text-muted-foreground sm:col-span-2">
                <input
                  aria-label="Use ElevenLabs streaming endpoint for preview"
                  type="checkbox"
                  checked={streamPreview}
                  onChange={(event) => setStreamPreview(event.target.checked)}
                  className="h-4 w-4 rounded border border-input bg-background accent-[var(--accent)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
                />
                Use Streaming Endpoint for Preview
              </label>
            </div>
          </div>

          <label htmlFor="preview-text" className="block text-sm font-medium text-muted-foreground">
            Preview Text
          </label>
          <textarea
            id="preview-text"
            aria-label="Text used for voice preview playback"
            value={previewText}
            onChange={(event) => setPreviewText(event.target.value)}
            className="h-24 w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
          />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Button
              aria-label="Save selected voice profile"
              onClick={saveProfile}
              disabled={saving || !selectedVoiceId}
              className="h-11"
            >
              <CheckCircle2 className="mr-2 h-5 w-5" aria-hidden="true" />
              {saving ? 'Saving...' : 'Save Profile'}
            </Button>
            <Button
              aria-label="Preview currently selected voice"
              onClick={() => previewVoice(selectedVoiceId)}
              disabled={!selectedVoiceId || previewingVoiceId !== null}
              variant="outline"
              className="h-11"
            >
              <Volume2 className="mr-2 h-5 w-5" aria-hidden="true" />
              {previewingVoiceId ? 'Playing...' : 'Preview Selected'}
            </Button>
          </div>

          <div className="space-y-4 border-t border-border pt-6">
            <h3 className="text-base font-semibold text-foreground">Accessibility Audio Tools</h3>
            <p className="text-xs text-muted-foreground">
              Run speech-to-speech, voice changer, sound effects, and dubbing from this panel.
            </p>

            <label
              htmlFor="transform-audio-file"
              className="block text-sm font-medium text-muted-foreground"
            >
              Source Audio File (for speech-to-speech / voice changer)
            </label>
            <input
              id="transform-audio-file"
              aria-label="Upload source audio for speech-to-speech or voice changer"
              type="file"
              accept="audio/*"
              onChange={(event) => setTransformFile(event.target.files?.[0] ?? null)}
              className="w-full cursor-pointer rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-foreground file:px-3 file:py-1 file:text-sm file:font-semibold file:text-background hover:file:opacity-90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
            />

            <label htmlFor="sts-model-id" className="block text-sm font-medium text-muted-foreground">
              Speech/Voice-Changer Model
            </label>
            <input
              id="sts-model-id"
              aria-label="ElevenLabs speech-to-speech model id"
              type="text"
              value={stsModelId}
              onChange={(event) => setStsModelId(event.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
            />

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Button
                aria-label="Run ElevenLabs speech to speech conversion"
                onClick={() => runTransformTool('s2s')}
                disabled={toolBusy !== 'none'}
                variant="outline"
                className="h-10"
              >
                {toolBusy === 's2s' ? 'Converting...' : 'Speech-to-Speech'}
              </Button>
              <Button
                aria-label="Run ElevenLabs voice changer conversion"
                onClick={() => runTransformTool('changer')}
                disabled={toolBusy !== 'none'}
                variant="outline"
                className="h-10"
              >
                {toolBusy === 'changer' ? 'Converting...' : 'Voice Changer'}
              </Button>
            </div>

            <label
              htmlFor="sound-effect-text"
              className="block text-sm font-medium text-muted-foreground"
            >
              Sound Effect Prompt
            </label>
            <input
              id="sound-effect-text"
              aria-label="Prompt for ElevenLabs sound effects generation"
              type="text"
              value={effectText}
              onChange={(event) => setEffectText(event.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
            />
            <Button
              aria-label="Generate sound effect"
              onClick={runSoundEffects}
              disabled={toolBusy !== 'none'}
              variant="outline"
              className="h-10"
            >
              {toolBusy === 'sfx' ? 'Generating...' : 'Generate Sound Effect'}
            </Button>

            <label
              htmlFor="dubbing-source-url"
              className="block text-sm font-medium text-muted-foreground"
            >
              Dubbing Source URL
            </label>
            <input
              id="dubbing-source-url"
              aria-label="Source media URL for ElevenLabs dubbing"
              type="url"
              value={dubbingSourceUrl}
              onChange={(event) => setDubbingSourceUrl(event.target.value)}
              placeholder="https://example.com/video.mp4"
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
            />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="dubbing-target-lang"
                  className="block text-sm font-medium text-muted-foreground"
                >
                  Target Language
                </label>
                <input
                  id="dubbing-target-lang"
                  aria-label="Target language code for dubbing"
                  type="text"
                  value={dubbingTargetLang}
                  onChange={(event) => setDubbingTargetLang(event.target.value)}
                  placeholder="en"
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
                />
              </div>
              <div>
                <label
                  htmlFor="dubbing-source-lang"
                  className="block text-sm font-medium text-muted-foreground"
                >
                  Source Language (Optional)
                </label>
                <input
                  id="dubbing-source-lang"
                  aria-label="Source language code for dubbing"
                  type="text"
                  value={dubbingSourceLang}
                  onChange={(event) => setDubbingSourceLang(event.target.value)}
                  placeholder="auto"
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
                />
              </div>
            </div>
            <Button
              aria-label="Create ElevenLabs dubbing job"
              onClick={runDubbing}
              disabled={toolBusy !== 'none'}
              variant="outline"
              className="h-10"
            >
              {toolBusy === 'dubbing' ? 'Submitting...' : 'Start Dubbing'}
            </Button>

            {lastDubbingResult && (
              <pre
                aria-label="Latest dubbing response payload"
                className="max-h-40 overflow-auto rounded-lg border border-border bg-background p-3 text-xs text-foreground"
              >
                {JSON.stringify(lastDubbingResult, null, 2)}
              </pre>
            )}
          </div>
        </section>

        <section className="space-y-6 rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-foreground">Available Voices</h2>
              <p className="text-sm text-muted-foreground">
                {filteredVoices.length} of {voices.length} voices match your filters
              </p>
            </div>
          </div>

          <div
            ref={statusRegionRef}
            tabIndex={-1}
            role="status"
            aria-live="polite"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
          >
            {statusMessage}
          </div>

          {loading ? (
            <p className="py-10 text-center text-muted-foreground">Loading voices...</p>
          ) : filteredVoices.length === 0 ? (
            <p className="py-10 text-center text-muted-foreground">No voices match current filters.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {filteredVoices.map((voice) => {
                const isSelected = selectedVoiceId === voice.voice_id
                return (
                  <li key={voice.voice_id} className="rounded-xl border border-border bg-background p-4">
                    <button
                      type="button"
                      aria-label={`Select voice ${voice.name}`}
                      aria-pressed={isSelected}
                      onClick={() => {
                        setSelectedVoiceId(voice.voice_id)
                        announce(`Selected voice: ${voice.name}`)
                      }}
                      className={`w-full rounded-lg border px-4 py-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background ${
                        isSelected
                          ? 'border-accent bg-background'
                          : 'border-border bg-card hover:bg-background'
                      }`}
                    >
                      <p className="text-lg font-semibold text-foreground">{voice.name}</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {prettyLabel(voice.gender)} · {prettyLabel(voice.age)} · {prettyLabel(voice.quality)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Notice: {prettyLabel(voice.notice_period)} | Custom Rates:{' '}
                        {voice.custom_rates === true ? 'Yes' : voice.custom_rates === false ? 'No' : 'Unknown'} |
                        Live Moderation:{' '}
                        {voice.live_moderation === true ? 'Yes' : voice.live_moderation === false ? 'No' : 'Unknown'}
                      </p>
                      {voice.descriptive && (
                        <p className="mt-2 text-xs text-muted-foreground">{voice.descriptive}</p>
                      )}
                    </button>

                    <div className="mt-2 flex gap-2">
                      <Button
                        aria-label={`Preview voice ${voice.name}`}
                        onClick={() => previewVoice(voice.voice_id)}
                        disabled={previewingVoiceId !== null}
                        variant="outline"
                        size="sm"
                        className="h-9"
                      >
                        <Volume2 className="mr-2 h-4 w-4" aria-hidden="true" />
                        {previewingVoiceId === voice.voice_id ? 'Playing...' : 'Preview'}
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
  )
}
