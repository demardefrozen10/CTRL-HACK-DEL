import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowUpRight, Play, X, Glasses, ArrowRight, Loader2 } from 'lucide-react'

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
import heroBackground from '@/assets/rb-hp-pday-sun-d.jpg'
import csHubLogo from '@/assets/CS Hub (4).png'

function apiBaseUrl() {
  const envBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim()
  if (envBase) return envBase.replace(/\/+$/, '')
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
  const host = window.location.hostname || '127.0.0.1'
  return `${protocol}//${host}:8010`
}

export function HomePage() {
  const [showLogin, setShowLogin] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const apiBase = apiBaseUrl()
  const modalRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const firstInputRef = useRef<HTMLInputElement>(null)

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
      {/* ── Hero ── */}
      <section 
        className="relative min-h-[85vh] w-full overflow-hidden"
        aria-labelledby="hero-heading"
      >
        <img
          src={heroBackground}
          alt=""
          role="presentation"
          className="absolute inset-0 h-full w-full object-cover opacity-40"
        />

        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/50 to-background" aria-hidden="true" />

        <header className="absolute left-0 right-0 top-0 z-20" role="banner">
          <div className="mx-auto flex h-20 w-full max-w-7xl items-center justify-between px-6 sm:px-10">
            <div className="flex items-center gap-2">
              <Glasses className="h-7 w-7 text-white" aria-hidden="true" />
              <span className="text-3xl font-bold italic tracking-tight text-white">VibeGlasses</span>
            </div>

            <nav aria-label="Main navigation" className="flex items-center gap-3">
              <Button
                variant="ghost"
                className="h-10 px-3 text-base font-medium text-white/80 hover:bg-white/10 hover:text-white"
                onClick={() => setShowLogin(true)}
                aria-label="Sign in to your account"
              >
                Sign in
              </Button>
              <Button
                size="sm"
                className="h-9 rounded-md bg-white px-5 text-sm font-semibold text-black hover:bg-white/90"
                onClick={() => setShowLogin(true)}
                aria-label="Get started with VibeGlasses"
              >
                Get started
              </Button>
            </nav>
          </div>
        </header>

        <div className="relative z-10 mx-auto flex min-h-[85vh] w-full max-w-5xl flex-col items-center justify-center px-6 pb-16 pt-32 text-center sm:px-10">
          <h1 
            id="hero-heading"
            className="max-w-4xl text-5xl font-bold leading-[1.08] tracking-tight text-white sm:text-6xl md:text-7xl mt-12"
          >
            VibeGlasses
          </h1>

          <p className="mt-6 max-w-2xl text-base leading-relaxed text-white/70 sm:text-lg">
            Design & program smart glasses for your visually impaired loved ones.
          </p>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-4" role="group" aria-label="Call to action buttons">
            <Button
              size="lg"
              className="h-12 gap-2 rounded-lg bg-white px-7 text-sm font-semibold text-black hover:bg-white/90"
              onClick={() => setShowLogin(true)}
              aria-label="Get started with VibeGlasses - opens sign in dialog"
            >
              Get Started
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-12 gap-2 rounded-lg border-white/20 bg-white/5 px-7 text-sm font-semibold text-white hover:bg-white/10"
            >
              <Link to="/carousel" aria-label="Watch demo video of VibeGlasses">
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                Watch Demo
              </Link>
            </Button>
          </div>

          {/* Powered By */}
          <div className="mt-10 flex flex-col items-center">
            <p className="text-l uppercase tracking-widest text-white/50 mb-5">Powered By</p>
            <img
              src={csHubLogo}
              alt="CS Hub - powering VibeGlasses"
              className="mt-2 h-auto w-20 object-contain"
            />
          </div>

          <div className="absolute bottom-0 left-1/2 flex -translate-x-1/2 items-center gap-4 text-xs text-white/50 sm:text-sm" aria-label="Product features">
            <span>Open source</span>
            <span className="h-1 w-1 rounded-full bg-white/30" aria-hidden="true" />
            <span>Arduino powered</span>
            <span className="h-1 w-1 rounded-full bg-white/30" aria-hidden="true" />
            <span>AI-enhanced</span>
          </div>
        </div>
      </section>

      {/* ── Content ── */}
      <section 
        className="mx-auto w-full max-w-6xl px-6 py-20 sm:px-10"
        aria-labelledby="how-it-works-heading"
      >
        <Separator className="mb-14 bg-white/10" role="presentation" />

        <div className="mb-10 max-w-2xl">
          <p className="mb-2 text-sm font-medium uppercase tracking-widest text-muted-foreground">
            How it works
          </p>
          <h2 
            id="how-it-works-heading"
            className="text-3xl font-semibold tracking-tight text-white sm:text-4xl"
          >
            Designed around real accessibility needs
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground">
            Echo-Sight targets micro-navigation—finding a chair, sensing a half-open door, or detecting a step—using a lightweight wearable hardware stack.
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-3" role="list" aria-label="Key features">
          <Card className="border-white/10 bg-card" role="listitem">
            <CardHeader>
              <CardTitle className="text-white">Spatial Feedback</CardTitle>
              <CardDescription>
                Camera input is processed and converted into directional haptic cues and spatial audio.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Users sense distance and orientation without needing to rely on visual focus.
            </CardContent>
          </Card>

          <Card className="border-white/10 bg-card" role="listitem">
            <CardHeader>
              <CardTitle className="text-white">Hardware Stack</CardTitle>
              <CardDescription>
                Arduino, servo and DC motors, accelerometer, IR and ultrasonic sensors, camera, and flashlight.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Compact enough for a glasses clip or wearable chassis attachment.
            </CardContent>
          </Card>

          <Card className="border-white/10 bg-card" role="listitem">
            <CardHeader>
              <CardTitle className="text-white">Real Impact</CardTitle>
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={() => setShowLogin(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="login-dialog-title"
          aria-describedby="login-dialog-description"
        >
          <div
            ref={modalRef}
            className="relative w-full max-w-xs rounded-2xl border border-white/10 bg-background px-6 pb-6 pt-5"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              ref={closeButtonRef}
              onClick={() => setShowLogin(false)}
              className="absolute right-5 top-5 rounded-md p-1 text-white/50 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/50"
              aria-label="Close login dialog"
              type="button"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>

            {/* Icon */}
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-xl bg-white" aria-hidden="true">
              <Glasses className="h-8 w-8 text-black" />
            </div>

            {/* Header */}
            <h2 id="login-dialog-title" className="mb-1 text-center text-2xl font-bold text-white">
              Welcome back!
            </h2>
            <p id="login-dialog-description" className="mb-6 text-center text-sm text-white/60">
              Please sign in to continue.
            </p>

            {/* Error Message - WCAG 3.3.1 Error Identification */}
            {error && (
              <div 
                role="alert" 
                aria-live="assertive"
                className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-center text-sm text-red-400"
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
                  className="h-12 rounded-lg border-white/10 bg-white/5 px-4"
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
                  className="h-12 rounded-lg border-white/10 bg-white/5 px-4"
                  required
                  autoComplete="current-password"
                  aria-required="true"
                  aria-invalid={error ? 'true' : 'false'}
                />
              </div>
              <Button
                type="submit"
                disabled={loading}
                className="h-12 w-full gap-2 rounded-lg bg-white text-base font-semibold text-black hover:bg-white/90 disabled:opacity-50"
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
            <p className="mt-6 text-center text-sm text-white/50">
              Beta access only. Contact us to get access.
            </p>
          </div>
        </div>
      )}
    </main>
  )
}
