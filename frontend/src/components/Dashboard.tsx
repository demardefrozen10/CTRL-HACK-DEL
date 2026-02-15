import { Paintbrush2, SunMoon } from 'lucide-react'

import { useTheme, type ThemeMode } from '@/context/ThemeContext'
import { Button } from '@/components/ui/button'

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'high-contrast', label: 'High Contrast' },
]

export function Dashboard() {
  const { theme, setTheme, accentColor, setAccentColor, resetAccentColor } = useTheme()
  const accentLocked = theme === 'high-contrast'
  const effectiveAccentColor = accentLocked ? '#ffff00' : accentColor

  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <header className="mb-5">
        <h2 className="text-xl font-semibold text-foreground">User Settings</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Change theme mode and test accent color updates in real time.
        </p>
      </header>

      <div className="space-y-6">
        <div>
          <p className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-muted-foreground">
            <SunMoon className="h-4 w-4" aria-hidden="true" />
            Theme
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            {THEME_OPTIONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant="outline"
                aria-pressed={theme === option.value}
                className={
                  theme === option.value
                    ? 'border-accent bg-accent text-background'
                    : 'border-border bg-background text-foreground hover:bg-card'
                }
                onClick={() => setTheme(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>

        <div>
          <label
            htmlFor="accent-color"
            className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-muted-foreground"
          >
            <Paintbrush2 className="h-4 w-4" aria-hidden="true" />
            Accent Color
          </label>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              id="accent-color"
              type="color"
              value={effectiveAccentColor}
              onChange={(event) => setAccentColor(event.target.value)}
              disabled={accentLocked}
              className="h-12 w-full cursor-pointer rounded-lg border border-border bg-background p-2 disabled:cursor-not-allowed disabled:opacity-70 sm:w-24"
              aria-describedby="accent-help"
            />
            <div
              className="h-12 w-full rounded-lg border border-border sm:w-24"
              style={{ backgroundColor: effectiveAccentColor }}
              aria-hidden="true"
            />
            <Button
              type="button"
              variant="outline"
              className="w-full border-border bg-background text-foreground hover:bg-card sm:w-auto"
              onClick={resetAccentColor}
              disabled={accentLocked}
            >
              Reset Accent
            </Button>
          </div>
          <p id="accent-help" className="mt-2 text-sm text-muted-foreground">
            {accentLocked
              ? 'High Contrast locks the accent color to yellow.'
              : `Selected accent: ${effectiveAccentColor.toUpperCase()}`}
          </p>
        </div>
      </div>
    </section>
  )
}
