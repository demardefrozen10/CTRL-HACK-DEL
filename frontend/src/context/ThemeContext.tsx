import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type ThemeMode = 'dark' | 'light' | 'high-contrast'

type ThemeContextValue = {
  theme: ThemeMode
  setTheme: (theme: ThemeMode) => void
  toggleTheme: () => void
  accentColor: string
  setAccentColor: (color: string) => void
  resetAccentColor: () => void
}

const STORAGE_THEME_KEY = 'sense.theme'
const STORAGE_ACCENT_KEY = 'sense.accent'
const LEGACY_THEME_KEY = 'vibeglasses.theme'
const LEGACY_ACCENT_KEY = 'vibeglasses.accent'
const THEME_SEQUENCE: ThemeMode[] = ['dark', 'light', 'high-contrast']

const DEFAULT_ACCENT: Record<ThemeMode, string> = {
  dark: '#22d3ee',
  light: '#115e59',
  'high-contrast': '#ffff00',
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function isTheme(value: string | null): value is ThemeMode {
  return value === 'dark' || value === 'light' || value === 'high-contrast'
}

function normalizeHexColor(value: string | null, fallback: string): string {
  if (!value) return fallback
  const isHex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
  return isHex ? value : fallback
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const storedTheme =
      localStorage.getItem(STORAGE_THEME_KEY) ?? localStorage.getItem(LEGACY_THEME_KEY)
    return isTheme(storedTheme) ? storedTheme : 'dark'
  })

  const [accentColor, setAccentColorState] = useState<string>(() => {
    const storedTheme =
      localStorage.getItem(STORAGE_THEME_KEY) ?? localStorage.getItem(LEGACY_THEME_KEY)
    const defaultTheme = isTheme(storedTheme) ? storedTheme : 'dark'
    const fallbackAccent = DEFAULT_ACCENT[defaultTheme]
    const storedAccent =
      localStorage.getItem(STORAGE_ACCENT_KEY) ?? localStorage.getItem(LEGACY_ACCENT_KEY)
    return normalizeHexColor(storedAccent, fallbackAccent)
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark'
    localStorage.setItem(STORAGE_THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accentColor)
    localStorage.setItem(STORAGE_ACCENT_KEY, accentColor)
  }, [accentColor])

  const setTheme = useCallback((nextTheme: ThemeMode) => {
    setThemeState(nextTheme)
  }, [])

  const toggleTheme = useCallback(() => {
    setThemeState((currentTheme) => {
      const index = THEME_SEQUENCE.indexOf(currentTheme)
      const nextTheme = THEME_SEQUENCE[(index + 1) % THEME_SEQUENCE.length]
      return nextTheme
    })
  }, [])

  const setAccentColor = useCallback((nextColor: string) => {
    setAccentColorState(normalizeHexColor(nextColor, DEFAULT_ACCENT.dark))
  }, [])

  const resetAccentColor = useCallback(() => {
    setAccentColorState(DEFAULT_ACCENT[theme])
  }, [theme])

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme,
      toggleTheme,
      accentColor,
      setAccentColor,
      resetAccentColor,
    }),
    [accentColor, resetAccentColor, setAccentColor, setTheme, theme, toggleTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
