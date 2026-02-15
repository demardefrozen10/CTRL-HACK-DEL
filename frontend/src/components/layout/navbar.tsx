import { Link, NavLink } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'

import { Button } from '@/components/ui/button'

const navItems = [
  { to: '/', label: 'Home' },
  { to: '/carousel', label: 'Styles' },
]

export function Navbar() {
  return (
    <header
      className="sticky top-0 z-50 border-b border-border bg-background"
      role="banner"
    >
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-6 sm:px-10">
        <Link
          to="/"
          className="text-xl font-bold tracking-tight text-foreground"
          aria-label="S.E.N.S.E. home"
        >
          S.E.N.S.E.
        </Link>

        <div className="flex items-center gap-4">
          <nav
            className="hidden items-center gap-1 md:flex"
            aria-label="Main navigation"
          >
            {navItems.map((item) => (
              <Button
                key={item.to}
                asChild
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:bg-card hover:text-foreground"
              >
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    isActive ? 'font-medium text-foreground' : ''
                  }
                  end={item.to === '/'}
                >
                  {item.label}
                </NavLink>
              </Button>
            ))}
          </nav>

          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 rounded-full border-border bg-background text-sm text-foreground hover:bg-card"
            aria-label="Get started with S.E.N.S.E."
          >
            Get started
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </header>
  )
}
