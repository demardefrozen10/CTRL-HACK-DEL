import { Navigate, Route, Routes } from 'react-router-dom'

import { CarouselPage } from '@/pages/carousel-page'
import { DashboardPage } from '@/pages/dashboard-page'
import { HomePage } from '@/pages/home-page'
import { VoiceStudioPage } from '@/pages/voice-studio-page'

function App() {
  return (
    <div className="min-h-screen bg-background">
      {/* Skip navigation link for WCAG 2.4.1 Bypass Blocks */}
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      
      {/* Live region for screen reader announcements - WCAG 4.1.3 Status Messages */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        id="announcement-region"
      />
      
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/carousel" element={<CarouselPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/voice-studio" element={<VoiceStudioPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  )
}

export default App
