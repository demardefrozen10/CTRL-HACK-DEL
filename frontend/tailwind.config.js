import tailwindcssAnimate from 'tailwindcss-animate'

/** @type {import('tailwindcss').Config} */
const config = {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Mulish', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 0.125rem)',
        sm: 'calc(var(--radius) - 0.25rem)',
      },
      colors: {
        background: 'var(--bg-main)',
        foreground: 'var(--text-main)',
        card: 'var(--bg-card)',
        'card-foreground': 'var(--text-main)',
        popover: 'var(--bg-card)',
        'popover-foreground': 'var(--text-main)',
        primary: 'var(--text-main)',
        'primary-foreground': 'var(--bg-main)',
        secondary: 'var(--bg-card)',
        'secondary-foreground': 'var(--text-main)',
        muted: 'var(--bg-card)',
        'muted-foreground': 'var(--text-muted)',
        accent: 'var(--accent)',
        'accent-foreground': 'var(--bg-main)',
        destructive: 'var(--destructive)',
        'destructive-foreground': 'var(--destructive-foreground)',
        border: 'var(--border)',
        input: 'var(--border)',
        ring: 'var(--accent)',
      },
    },
  },
  plugins: [tailwindcssAnimate],
}

export default config
