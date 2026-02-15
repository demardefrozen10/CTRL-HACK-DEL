import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, Glasses, ArrowRight, Loader2 } from 'lucide-react'

import { Hero } from '@/components/Hero'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Input } from '@/components/ui/input'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

function apiBaseUrl() {
  const envBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim()
  if (envBase) return envBase.replace(/\/+$/, '')
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
  const host = window.location.hostname || '127.0.0.1'
  return `${protocol}//${host}:8000`
}

export function HomePage() {
  const [showLogin, setShowLogin] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const modalRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const firstInputRef = useRef<HTMLInputElement>(null)
  const apiBase = useMemo(apiBaseUrl, [])

  // Focus management for modal - WCAG 2.4.3 Focus Order
  useEffect(() => {
    if (showLogin) {
      // Store the previously focused element
      const previouslyFocused = document.activeElement as HTMLElement
      
      // Focus the first input when modal opens
      setTimeout(() => {
        firstInputRef.current?.focus()
      }, 100)

      // Trap focus within modal
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          setShowLogin(false)
          previouslyFocused?.focus()
        }
        
        if (e.key === 'Tab') {
          const focusableElements = modalRef.current?.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          )
          if (!focusableElements?.length) return
          
          const firstElement = focusableElements[0] as HTMLElement
          const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement
          
          if (e.shiftKey && document.activeElement === firstElement) {
            e.preventDefault()
            lastElement.focus()
          } else if (!e.shiftKey && document.activeElement === lastElement) {
            e.preventDefault()
            firstElement.focus()
          }
        }
      }

      document.addEventListener('keydown', handleKeyDown)
      return () => {
        document.removeEventListener('keydown', handleKeyDown)
        previouslyFocused?.focus()
      }
    }
  }, [showLogin])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const formData = new URLSearchParams()
      formData.append('username', username)
      formData.append('password', password)

      const response = await fetch(`${apiBase}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData,
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.detail || 'Login failed')
      }

      const data = await response.json()
      localStorage.setItem('token', data.access_token)
      localStorage.setItem('username', username)
      navigate('/dashboard')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main id="main-content" className="w-full" role="main">
      <Hero onGetStarted={() => setShowLogin(true)} onSignIn={() => setShowLogin(true)} />

      {/* ── Content ── */}
      <section
        className="mx-auto w-full max-w-6xl px-6 pb-20 pt-16 sm:px-10"
        aria-labelledby="how-it-works-heading"
      >
        <Separator className="mb-10 opacity-60" role="presentation" />

        <div className="mb-10 max-w-2xl">
          <p className="mb-2 text-sm font-medium uppercase tracking-widest text-muted-foreground">
            How it works
          </p>
          <h2
            id="how-it-works-heading"
            className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl"
          >
            Designed around real accessibility needs
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground">
            S.E.N.S.E. targets micro-navigation, like finding a chair, sensing a half-open door, or detecting a step, using a lightweight wearable hardware stack.
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-3" role="list" aria-label="Key features">
          <Card role="listitem">
            <CardHeader>
              <CardTitle className="text-foreground">Spatial Feedback</CardTitle>
              <CardDescription>
                Camera input is processed and converted into directional haptic cues and spatial audio.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Users sense distance and orientation without needing to rely on visual focus.
            </CardContent>
          </Card>

          <Card role="listitem">
            <CardHeader>
              <CardTitle className="text-foreground">Hardware Stack</CardTitle>
              <CardDescription>
                Arduino, servo and DC motors, accelerometer, IR and ultrasonic sensors, camera, and flashlight.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Compact enough for a glasses clip or wearable chassis attachment.
            </CardContent>
          </Card>

          <Card role="listitem">
            <CardHeader>
              <CardTitle className="text-foreground">Real Impact</CardTitle>
              <CardDescription>
                Bridges the gap between macro wayfinding and close-range obstacle awareness.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Increases confidence and independence for visually impaired users in everyday spaces.
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ── Login Modal - WCAG compliant dialog ── */}
      {showLogin && (
        <div
          className="modal-scrim fixed inset-0 z-50 flex items-center justify-center px-6 py-10"
          onClick={() => setShowLogin(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="login-dialog-title"
          aria-describedby="login-dialog-description"
        >
          <div
            ref={modalRef}
            className="relative w-full max-w-sm rounded-2xl border border-border bg-background px-6 pb-7 pt-6 shadow-lg sm:max-w-md sm:px-8"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              ref={closeButtonRef}
              onClick={() => setShowLogin(false)}
              className="absolute right-5 top-5 rounded-lg p-2 text-muted-foreground hover:bg-card hover:text-foreground"
              aria-label="Close login dialog"
              type="button"
            >
              <X className="h-6 w-6" aria-hidden="true" />
            </button>

            {/* Icon */}
            <div
              className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-xl border border-border bg-card"
              aria-hidden="true"
            >
              <Glasses className="h-8 w-8 text-foreground" />
            </div>

            {/* Header */}
            <h2
              id="login-dialog-title"
              className="mb-2 text-center text-3xl font-bold tracking-tight text-foreground"
            >
              Welcome back!
            </h2>
            <p id="login-dialog-description" className="mb-7 text-center text-base text-muted-foreground">
              Please sign in to continue.
            </p>

            {/* Error Message - WCAG 3.3.1 Error Identification */}
            {error && (
              <div
                role="alert"
                aria-live="assertive"
                className="mb-4 rounded-lg border border-destructive bg-card p-3 text-center text-sm text-foreground"
              >
                <span className="sr-only">Error: </span>
                {error}
              </div>
            )}

            {/* Form - WCAG 3.3.2 Labels or Instructions */}
            <form onSubmit={handleLogin} className="space-y-4" noValidate>
              <div>
                <label htmlFor="username" className="sr-only">
                  Username
                </label>
                <Input
                  ref={firstInputRef}
                  id="username"
                  type="text"
                  placeholder="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="h-12 rounded-xl px-4 text-base"
                  required
                  autoComplete="username"
                  aria-required="true"
                  aria-invalid={error ? 'true' : 'false'}
                />
              </div>
              <div>
                <label htmlFor="password" className="sr-only">
                  Password
                </label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-12 rounded-xl px-4 text-base"
                  required
                  autoComplete="current-password"
                  aria-required="true"
                  aria-invalid={error ? 'true' : 'false'}
                />
              </div>
              <Button
                type="submit"
                disabled={loading}
                className="h-12 w-full gap-2 rounded-xl bg-foreground text-base font-semibold text-background hover:opacity-90 disabled:opacity-50"
                aria-label={loading ? 'Signing in...' : 'Sign in to your account'}
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    <span>Signing in...</span>
                  </>
                ) : (
                  <>
                    Sign in
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </>
                )}
              </Button>
            </form>

            {/* Footer */}
            <p className="mt-6 text-center text-sm text-muted-foreground">
              Beta access only. Contact us to get access.
            </p>
          </div>
        </div>
      )}
    </main>
  )
}
