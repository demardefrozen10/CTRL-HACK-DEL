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

  useEffect(() => {
    if (!authToken) {
      navigate('/')
      return
    }

    const load = async () => {
      setLoading(true)
      try {
        const [voicesRes, profileRes] = await Promise.all([
          fetch(`${apiBase}/voice-studio/voices`, { headers: authHeaders }),
          fetch(`${apiBase}/voice-studio/profile`, { headers: authHeaders }),
        ])

        if (!voicesRes.ok) {
          throw new Error(`Could not load voices (${voicesRes.status})`)
        }
        if (!profileRes.ok) {
          throw new Error(`Could not load profile (${profileRes.status})`)
        }

        const voicesPayload = (await voicesRes.json()) as { voices: VoiceItem[] }
        const profilePayload = (await profileRes.json()) as VoiceProfile

        setVoices(voicesPayload.voices || [])
        setSelectedVoiceId(profilePayload.voice_id || voicesPayload.voices?.[0]?.voice_id || '')
        setStability(profilePayload.stability ?? 0.5)
        setClarity(profilePayload.clarity ?? 0.75)
        setStyleExaggeration(profilePayload.style_exaggeration ?? 0.0)
        setPlaybackSpeed(profilePayload.playback_speed ?? 1.0)
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
      const response = await fetch(`${apiBase}/voice-studio/preview`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...currentProfile,
          voice_id: voiceId,
          text: previewText.trim() || 'Echo-Sight voice preview.',
        }),
      })
      if (response.status === 204) {
        announce('Preview unavailable. Check ElevenLabs API key or quota.')
        return
      }
      if (!response.ok) {
        throw new Error(`Preview failed (${response.status})`)
      }
      const audio = new Audio(URL.createObjectURL(await response.blob()))
      await audio.play()
      announce(`Playing preview for ${voices.find((v) => v.voice_id === voiceId)?.name ?? voiceId}`)
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Voice preview failed')
    } finally {
      setPreviewingVoiceId(null)
    }
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_10%_0%,#3f240f_0%,#1a0f07_42%,#0f0905_100%)] text-[#fff2dd]">
      <header className="border-b border-[#f8b15f]/50 bg-[#1a0f07]/95 px-5 py-4 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[#ffd6a2]">Echo-Sight</p>
            <h1 className="text-2xl font-semibold text-[#fff2dd]">Voice Studio</h1>
          </div>
          <Button
            aria-label="Back to dashboard"
            onClick={() => navigate('/dashboard')}
            className="h-11 border border-[#ffd6a2]/60 bg-[#2d1808] px-5 text-[#fff1da] hover:bg-[#47270f] focus-visible:ring-2 focus-visible:ring-[#ffe3c0] focus-visible:ring-offset-2 focus-visible:ring-offset-[#1a0f07]"
          >
            <ArrowLeft className="mr-2 h-5 w-5" />
            Back to Dashboard
          </Button>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1400px] grid-cols-1 gap-6 p-5 lg:grid-cols-[380px_minmax(0,1fr)]">
        <section className="space-y-5 rounded-2xl border border-[#f8b15f]/50 bg-[#1e1109]/90 p-5">
          <div className="flex items-center gap-2">
            <Filter className="h-5 w-5 text-[#ffd6a2]" />
            <h2 className="text-lg font-semibold text-[#ffe9c8]">Voice Filters</h2>
          </div>

          <fieldset className="space-y-3">
            <legend className="sr-only">Voice metadata filters</legend>

            <label htmlFor="quality-filter" className="block text-sm text-[#ffe0b8]">
              Quality
            </label>
            <select
              id="quality-filter"
              aria-label="Filter voices by quality"
              value={filters.quality}
              onChange={(event) => setFilters((current) => ({ ...current, quality: event.target.value as Filters['quality'] }))}
              className="w-full rounded-lg border border-[#f8b15f]/50 bg-[#120a05] px-3 py-2 text-[#fff3de] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffe3c0]"
            >
              <option value="any">Any</option>
              <option value="hq">HQ</option>
            </select>

            <label htmlFor="gender-filter" className="block text-sm text-[#ffe0b8]">
              Gender
            </label>
            <select
              id="gender-filter"
              aria-label="Filter voices by gender"
              value={filters.gender}
              onChange={(event) => setFilters((current) => ({ ...current, gender: event.target.value as Filters['gender'] }))}
              className="w-full rounded-lg border border-[#f8b15f]/50 bg-[#120a05] px-3 py-2 text-[#fff3de] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffe3c0]"
            >
              <option value="any">Any</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="neutral">Neutral</option>
            </select>

            <label htmlFor="age-filter" className="block text-sm text-[#ffe0b8]">
              Age
            </label>
            <select
              id="age-filter"
              aria-label="Filter voices by age"
              value={filters.age}
              onChange={(event) => setFilters((current) => ({ ...current, age: event.target.value as Filters['age'] }))}
              className="w-full rounded-lg border border-[#f8b15f]/50 bg-[#120a05] px-3 py-2 text-[#fff3de] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffe3c0]"
            >
              <option value="any">Any</option>
              <option value="young">Young</option>
              <option value="middle_aged">Middle Aged</option>
              <option value="old">Old</option>
            </select>

            <label htmlFor="notice-filter" className="block text-sm text-[#ffe0b8]">
              Notice Period
            </label>
            <select
              id="notice-filter"
              aria-label="Filter voices by notice period"
              value={filters.notice_period}
              onChange={(event) =>
                setFilters((current) => ({ ...current, notice_period: event.target.value as Filters['notice_period'] }))
              }
              className="w-full rounded-lg border border-[#f8b15f]/50 bg-[#120a05] px-3 py-2 text-[#fff3de] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffe3c0]"
            >
              <option value="any">Any</option>
              <option value="30d">30d</option>
              <option value="90d">90d</option>
              <option value="1y">1y</option>
            </select>

            <label htmlFor="custom-rates-filter" className="block text-sm text-[#ffe0b8]">
              Custom Rates
            </label>
            <select
              id="custom-rates-filter"
              aria-label="Filter voices by custom rates support"
              value={filters.custom_rates}
              onChange={(event) =>
                setFilters((current) => ({ ...current, custom_rates: event.target.value as InclusionFilter }))
              }
              className="w-full rounded-lg border border-[#f8b15f]/50 bg-[#120a05] px-3 py-2 text-[#fff3de] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffe3c0]"
            >
              <option value="any">Any</option>
              <option value="include">Include</option>
              <option value="exclude">Exclude</option>
            </select>

            <label htmlFor="live-moderation-filter" className="block text-sm text-[#ffe0b8]">
              Live Moderation
            </label>
            <select
              id="live-moderation-filter"
              aria-label="Filter voices by live moderation support"
              value={filters.live_moderation}
              onChange={(event) =>
                setFilters((current) => ({ ...current, live_moderation: event.target.value as InclusionFilter }))
              }
              className="w-full rounded-lg border border-[#f8b15f]/50 bg-[#120a05] px-3 py-2 text-[#fff3de] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffe3c0]"
            >
              <option value="any">Any</option>
              <option value="include">Include</option>
              <option value="exclude">Exclude</option>
            </select>
          </fieldset>

          <div className="space-y-3 border-t border-[#f8b15f]/35 pt-4">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-5 w-5 text-[#ffd6a2]" />
              <h3 className="text-base font-semibold text-[#ffe8c8]">Voice Tuning</h3>
            </div>

            <label htmlFor="stability-slider" className="block text-sm text-[#ffe0b8]">
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
              className="w-full accent-[#ffbe74] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffe3c0]"
            />

            <label htmlFor="clarity-slider" className="block text-sm text-[#ffe0b8]">
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
              className="w-full accent-[#ffbe74] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffe3c0]"
            />

            <label htmlFor="style-slider" className="block text-sm text-[#ffe0b8]">
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
              className="w-full accent-[#ffbe74] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffe3c0]"
            />

            <label htmlFor="speed-slider" className="block text-sm text-[#ffe0b8]">
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
              className="w-full accent-[#ffbe74] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffe3c0]"
            />
          </div>

          <label htmlFor="preview-text" className="block text-sm text-[#ffe0b8]">
            Preview Text
          </label>
          <textarea
            id="preview-text"
            aria-label="Text used for voice preview playback"
            value={previewText}
            onChange={(event) => setPreviewText(event.target.value)}
            className="h-24 w-full resize-none rounded-lg border border-[#f8b15f]/50 bg-[#120a05] px-3 py-2 text-sm text-[#fff3de] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffe3c0]"
          />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Button
              aria-label="Save selected voice profile"
              onClick={saveProfile}
              disabled={saving || !selectedVoiceId}
              className="h-11 bg-[#ffbe74] text-[#2d1607] hover:bg-[#ffd29a] focus-visible:ring-2 focus-visible:ring-[#ffe3c0]"
            >
              <CheckCircle2 className="mr-2 h-5 w-5" />
              {saving ? 'Saving...' : 'Save Profile'}
            </Button>
            <Button
              aria-label="Preview currently selected voice"
              onClick={() => previewVoice(selectedVoiceId)}
              disabled={!selectedVoiceId || previewingVoiceId !== null}
              className="h-11 border border-[#f8b15f]/60 bg-[#2d1808] text-[#fff1da] hover:bg-[#47270f] focus-visible:ring-2 focus-visible:ring-[#ffe3c0]"
            >
              <Volume2 className="mr-2 h-5 w-5" />
              {previewingVoiceId ? 'Playing...' : 'Preview Selected'}
            </Button>
          </div>
        </section>

        <section className="space-y-4 rounded-2xl border border-[#f8b15f]/50 bg-[#1e1109]/90 p-5">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-[#fff0d2]">Available Voices</h2>
              <p className="text-sm text-[#ffd7a3]">
                {filteredVoices.length} of {voices.length} voices match your filters
              </p>
            </div>
          </div>

          <div
            ref={statusRegionRef}
            tabIndex={-1}
            role="status"
            aria-live="polite"
            className="rounded-lg border border-[#f8b15f]/40 bg-[#2b1709] px-3 py-2 text-sm text-[#ffe6bf] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffe3c0]"
          >
            {statusMessage}
          </div>

          {loading ? (
            <p className="py-10 text-center text-[#ffdcb0]">Loading voices...</p>
          ) : filteredVoices.length === 0 ? (
            <p className="py-10 text-center text-[#ffdcb0]">No voices match current filters.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {filteredVoices.map((voice) => {
                const isSelected = selectedVoiceId === voice.voice_id
                return (
                  <li key={voice.voice_id} className="rounded-xl border border-[#f8b15f]/30 bg-[#180d06] p-3">
                    <button
                      type="button"
                      aria-label={`Select voice ${voice.name}`}
                      aria-pressed={isSelected}
                      onClick={() => {
                        setSelectedVoiceId(voice.voice_id)
                        announce(`Selected voice: ${voice.name}`)
                      }}
                      className={`w-full rounded-lg border px-3 py-3 text-left transition ${
                        isSelected
                          ? 'border-[#ffd6a2] bg-[#3a200d]'
                          : 'border-[#f8b15f]/30 bg-[#241208] hover:bg-[#342010]'
                      } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffe3c0]`}
                    >
                      <p className="text-lg font-semibold text-[#fff0d5]">{voice.name}</p>
                      <p className="mt-1 text-sm text-[#ffdcb2]">
                        {prettyLabel(voice.gender)} · {prettyLabel(voice.age)} · {prettyLabel(voice.quality)}
                      </p>
                      <p className="mt-1 text-xs text-[#ffc685]">
                        Notice: {prettyLabel(voice.notice_period)} | Custom Rates:{' '}
                        {voice.custom_rates === true ? 'Yes' : voice.custom_rates === false ? 'No' : 'Unknown'} |
                        Live Moderation:{' '}
                        {voice.live_moderation === true ? 'Yes' : voice.live_moderation === false ? 'No' : 'Unknown'}
                      </p>
                      {voice.descriptive && (
                        <p className="mt-2 text-xs text-[#f5d6ad]">{voice.descriptive}</p>
                      )}
                    </button>

                    <div className="mt-2 flex gap-2">
                      <Button
                        aria-label={`Preview voice ${voice.name}`}
                        onClick={() => previewVoice(voice.voice_id)}
                        disabled={previewingVoiceId !== null}
                        className="h-9 border border-[#f8b15f]/50 bg-[#3a1f0e] text-[#ffe4bc] hover:bg-[#4d2a13] focus-visible:ring-2 focus-visible:ring-[#ffe3c0]"
                      >
                        <Volume2 className="mr-2 h-4 w-4" />
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
