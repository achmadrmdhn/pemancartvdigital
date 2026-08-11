import { useEffect, useMemo, useState } from 'react'
import { MapView } from './components/MapView'
import './App.css'
import type { RankedTransmitter, Transmitter, UserLocation } from './types'
import {
  calculateBearing,
  calculateDistanceKm,
  formatDistanceKm,
  getCompassDirection,
} from './utils/geospatial'
import { searchNearbyTransmitters } from './utils/transmitterSearch'
import {
  isGeminiConfigured,
  generateAIScoresAndRecommendations,
  analyzeSearchQuery,
  compareTransmitters,
  searchTransmittersWithAI,
  setQuotaCallback,
} from './utils/geminiService'

type LocationStatus = 'idle' | 'loading' | 'success' | 'denied' | 'error'
type SearchStatus = 'idle' | 'loading' | 'success' | 'empty' | 'error'
type CompassStatus = 'idle' | 'available' | 'denied' | 'unavailable' | 'pending'
type ViewState = 'main' | 'compass'

declare global {
  interface Window {
    DeviceOrientationEvent?: typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<'granted' | 'denied'>
    }
  }
}

function parseMarkdownToHtml(markdown: string): string {
  // Convert headers
  let html = markdown
    .replace(/^#### (.*?)$/gm, '<h4>$1</h4>')
    .replace(/^### (.*?)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*?)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*?)$/gm, '<h1>$1</h1>')
  
  // Convert list items
  html = html.replace(/^[-*]\s+(.*?)$/gm, '<li>$1</li>')
  
  // Convert bold texts
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
  
  // Wrap list items in ul tags if they are consecutive (simple wrap)
  // We split by double newlines to treat as paragraphs
  const blocks = html.split(/\n\s*\n/)
  return blocks
    .map((block) => {
      const trimmed = block.trim()
      if (!trimmed) return ''
      if (trimmed.startsWith('<h') || trimmed.startsWith('<li')) {
        if (trimmed.startsWith('<li')) {
          return `<ul>${trimmed}</ul>`
        }
        return trimmed
      }
      return `<p>${trimmed.replace(/\n/g, '<br />')}</p>`
    })
    .join('')
}

// Simple Markdown Renderer to keep bundle size light and zero dependencies
function MarkdownRenderer({ content }: { content: string }) {
  const html = useMemo(() => parseMarkdownToHtml(content), [content])
  return (
    <div className="markdown-content" dangerouslySetInnerHTML={{ __html: html }} />
  )
}

function App() {
  const [location, setLocation] = useState<UserLocation | null>(null)
  const [locationStatus, setLocationStatus] = useState<LocationStatus>('idle')
  const [locationError, setLocationError] = useState<string | null>(null)
  const [transmitters, setTransmitters] = useState<Transmitter[]>([])
  const [searchStatus, setSearchStatus] = useState<SearchStatus>('idle')
  const [searchMessage, setSearchMessage] = useState<string | null>(null)
  const [selectedTransmitterId, setSelectedTransmitterId] = useState<number | null>(null)
  const [viewState, setViewState] = useState<ViewState>('main')
  const [compassStatus, setCompassStatus] = useState<CompassStatus>('idle')
  const [heading, setHeading] = useState<number | null>(null)
  const [compassError, setCompassError] = useState<string | null>(null)

  // AI Gemini States
  const [aiScores, setAiScores] = useState<Record<number, { score: number; recommendation: string }>>({})
  const [aiBestTransmitterId, setAiBestTransmitterId] = useState<number | null>(null)
  const [aiBestTransmitterReason, setAiBestTransmitterReason] = useState<string | null>(null)
  const [aiSearchInput, setAiSearchInput] = useState<string>('')
  const [isAISearching, setIsAISearching] = useState<boolean>(false)
  const [aiSearchExplanation, setAiSearchExplanation] = useState<string | null>(null)
  const [filteredTransmitterIds, setFilteredTransmitterIds] = useState<number[] | null>(null)
  const [selectedCompareIds, setSelectedCompareIds] = useState<number[]>([])
  const [aiCompareText, setAiCompareText] = useState<string | null>(null)
  const [isAIComparing, setIsAIComparing] = useState<boolean>(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [isQuotaExceeded, setIsQuotaExceeded] = useState<boolean>(false)

  const isOrientationSupported = typeof window !== 'undefined' && Boolean(window.DeviceOrientationEvent)
  const showInitialState = locationStatus === 'idle'
  const showLoadingState = locationStatus === 'loading' || searchStatus === 'loading'

  const requestLocation = async () => {
    if (!navigator.geolocation) {
      setLocationStatus('error')
      setLocationError('Browser Anda tidak mendukung Geolocation.')
      setSearchStatus('error')
      setSearchMessage('Browser Anda tidak mendukung pencarian pemancar dari sumber online.')
      return
    }

    setLocationStatus('loading')
    setLocationError(null)
    setSearchStatus('loading')
    setSearchMessage('Mencari pemancar TV di sekitar lokasi Anda...')
    setTransmitters([])
    setSelectedTransmitterId(null)
    setViewState('main')
    setCompassStatus('idle')
    setCompassError(null)
    setHeading(null)
    setAiScores({})
    setAiBestTransmitterId(null)
    setAiBestTransmitterReason(null)
    setFilteredTransmitterIds(null)
    setAiSearchExplanation(null)
    setAiSearchInput('')
    setSelectedCompareIds([])
    setAiCompareText(null)
    setAiError(null)
    setIsQuotaExceeded(false)

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const nextLocation = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        }

        setLocation(nextLocation)
        setLocationStatus('success')

        try {
          let results: Transmitter[] = []
          let fetchedByAI = false

          // Try searching using Gemini AI first if configured
          if (isGeminiConfigured()) {
            try {
              const aiResults = await searchTransmittersWithAI(nextLocation)
              if (aiResults && aiResults.length > 0) {
                results = aiResults
                fetchedByAI = true
              }
            } catch (err) {
              console.warn('Gagal mencari pemancar menggunakan Gemini AI, beralih ke kueri Overpass:', err)
            }
          }

          // Fallback to standard Overpass/OSM query if AI search failed or is not configured
          if (!fetchedByAI) {
            results = await searchNearbyTransmitters(nextLocation)
          }

          const cleanResults = results.filter(
            (t) =>
              !/mnc tower|menara mnc|mnc center|mnc plaza|mnc studios|sctv tower|trans tv tendean|menara kominfo|kominfo cibinong/i.test(t.name)
          )

          setTransmitters(cleanResults)

          if (results.length === 0) {
            setSearchStatus('empty')
            setSearchMessage('Pemancar TV di sekitar lokasi Anda tidak ditemukan.')
            return
          }

          setSearchStatus('success')
          setSearchMessage(null)

          // Run AI Scoring if Gemini is configured
          if (isGeminiConfigured()) {
            try {
              const ranked = results.map((t) => ({
                transmitter: t,
                distanceKm: calculateDistanceKm(nextLocation, t),
                bearing: calculateBearing(nextLocation, t),
              }))
              const result = await generateAIScoresAndRecommendations(nextLocation, ranked)
              
              const scoresMap: Record<number, { score: number; recommendation: string }> = {}
              result.scores.forEach((s) => {
                scoresMap[s.id] = { score: s.score, recommendation: s.recommendation }
              })
              setAiScores(scoresMap)
              setAiBestTransmitterId(result.bestTransmitterId)
              setAiBestTransmitterReason(result.bestTransmitterReason)
            } catch (err: any) {
              console.warn('Gagal memuat rekomendasi AI Gemini:', err)
              setAiError('Gagal memproses rekomendasi AI Gemini. Menggunakan penilaian dasar.')
            }
          }
        } catch {
          setTransmitters([])
          setSearchStatus('error')
          setSearchMessage('Tidak dapat memuat pemancar TV dari sumber online saat ini.')
        }
      },
      (error) => {
        if (error.code === 1) {
          setLocationStatus('denied')
          setLocationError('Akses lokasi ditolak. Aktifkan izin lokasi browser untuk melanjutkan.')
          setSearchStatus('empty')
          setSearchMessage('Izinkan lokasi untuk mencari pemancar TV terdekat.')
          return
        }

        setLocationStatus('error')
        setLocationError('Tidak dapat membaca lokasi Anda saat ini. Coba lagi sebentar.')
        setSearchStatus('error')
        setSearchMessage('Tidak dapat memproses pencarian pemancar saat ini.')
      },
      {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 0,
      },
    )
  }

  // Calculate ranked list of transmitters
  const allRankedTransmitters = useMemo<RankedTransmitter[]>(() => {
    if (!location || transmitters.length === 0) {
      return []
    }

    return transmitters
      .map((transmitter) => {
        const distanceKm = calculateDistanceKm(location, transmitter)
        const bearing = calculateBearing(location, transmitter)

        return { transmitter, distanceKm, bearing }
      })
      .sort((left, right) => left.distanceKm - right.distanceKm)
  }, [location, transmitters])

  // Filter ranked list if AI Search filter is active
  const rankedTransmitters = useMemo<RankedTransmitter[]>(() => {
    if (filteredTransmitterIds !== null) {
      return allRankedTransmitters.filter((item) =>
        filteredTransmitterIds.includes(item.transmitter.id)
      )
    }
    return allRankedTransmitters
  }, [allRankedTransmitters, filteredTransmitterIds])

  // Helper functions for scoring
  const getAIScore = (item: RankedTransmitter) => {
    const id = item.transmitter.id
    if (aiScores[id]) {
      return aiScores[id].score
    }
    // Default score if Gemini is not configured
    return Math.max(10, Math.round(100 - item.distanceKm * 1.5))
  }

  const getAIRecommendation = (item: RankedTransmitter) => {
    const id = item.transmitter.id
    if (aiScores[id]) {
      return aiScores[id].recommendation
    }
    const score = getAIScore(item)
    return score >= 80 ? 'Sangat baik' : score >= 60 ? 'Baik' : score >= 40 ? 'Cukup' : 'Kurang'
  }

  const getScoreClass = (score: number) => {
    if (score >= 80) return 'score-high'
    if (score >= 50) return 'score-medium'
    return 'score-low'
  }

  // AI Search Input Handler
  const handleAISearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!aiSearchInput.trim() || !location) return

    setIsAISearching(true)
    setAiError(null)

    try {
      const result = await analyzeSearchQuery(aiSearchInput, location, allRankedTransmitters)
      setFilteredTransmitterIds(result.matchingIds)
      setAiSearchExplanation(result.searchExplanation)

      if (result.matchingIds.length > 0) {
        setSelectedTransmitterId(result.matchingIds[0])
      } else {
        setSelectedTransmitterId(null)
      }
    } catch (err: any) {
      console.error(err)
      setAiError('Gagal memproses pencarian AI: ' + err.message)
    } finally {
      setIsAISearching(false)
    }
  }

  const handleResetAISearch = () => {
    setFilteredTransmitterIds(null)
    setAiSearchExplanation(null)
    setAiSearchInput('')
    setAiError(null)
    if (allRankedTransmitters.length > 0) {
      setSelectedTransmitterId(allRankedTransmitters[0].transmitter.id)
    }
  }

  // Comparison Handlers
  const handleToggleCompare = (id: number) => {
    setSelectedCompareIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  const handleRunComparison = async () => {
    if (selectedCompareIds.length < 2 || !location) return

    setIsAIComparing(true)
    setAiError(null)
    setAiCompareText(null)

    try {
      const selectedRanked = allRankedTransmitters.filter((t) =>
        selectedCompareIds.includes(t.transmitter.id)
      )
      const text = await compareTransmitters(location, selectedRanked)
      setAiCompareText(text)
    } catch (err: any) {
      console.error(err)
      setAiError('Gagal memproses perbandingan AI: ' + err.message)
    } finally {
      setIsAIComparing(false)
    }
  }

  const handleClearComparison = () => {
    setAiCompareText(null)
    setSelectedCompareIds([])
    setAiError(null)
  }

  // Set default selected transmitter
  useEffect(() => {
    if (rankedTransmitters.length === 0) {
      setSelectedTransmitterId(null)
      return
    }

    const hasSelected = rankedTransmitters.some((item) => item.transmitter.id === selectedTransmitterId)
    if (!hasSelected) {
      setSelectedTransmitterId(rankedTransmitters[0].transmitter.id)
    }
  }, [rankedTransmitters, selectedTransmitterId])

  // Register Gemini Quota callback
  useEffect(() => {
    setQuotaCallback(() => {
      setIsQuotaExceeded(true)
    })
  }, [])

  const activeTarget = useMemo(() => {
    if (rankedTransmitters.length === 0) {
      return null
    }

    if (selectedTransmitterId === null) {
      return rankedTransmitters[0]
    }

    return rankedTransmitters.find((item) => item.transmitter.id === selectedTransmitterId) ?? rankedTransmitters[0]
  }, [rankedTransmitters, selectedTransmitterId])

  const alternatives = useMemo(
    () => rankedTransmitters.filter((item) => item.transmitter.id !== activeTarget?.transmitter.id),
    [rankedTransmitters, activeTarget],
  )

  // Listen to orientation events (supporting Android absolute API & iOS standard API)
  useEffect(() => {
    if (viewState !== 'compass' || compassStatus !== 'available') {
      return
    }

    const handleOrientation = (event: any) => {
      // iOS has webkitCompassHeading which is pre-calibrated, absolute, and clockwise
      if (typeof event.webkitCompassHeading === 'number') {
        setHeading(event.webkitCompassHeading)
        return
      }

      // Android/Chrome sends absolute values (0 to 360) in counter-clockwise direction.
      // We convert it to clockwise compass heading using (360 - alpha) % 360.
      if (typeof event.alpha === 'number') {
        const alpha = event.alpha
        const clockwiseHeading = (360 - alpha) % 360
        setHeading(clockwiseHeading)
      }
    }

    // Android Chrome requires 'deviceorientationabsolute' for true absolute compass orientation.
    // iOS Safari uses 'deviceorientation' with webkitCompassHeading.
    const useAbsolute = 'ondeviceorientationabsolute' in window

    if (useAbsolute) {
      window.addEventListener('deviceorientationabsolute', handleOrientation, true)
    } else {
      window.addEventListener('deviceorientation', handleOrientation, true)
    }

    return () => {
      if (useAbsolute) {
        window.removeEventListener('deviceorientationabsolute', handleOrientation, true)
      } else {
        window.removeEventListener('deviceorientation', handleOrientation, true)
      }
    }
  }, [compassStatus, viewState])

  const bearing = activeTarget?.bearing ?? 0
  const compassDirection = getCompassDirection(bearing)
  const compassRoseRotation = heading !== null ? -heading : 0
  const alignDiff =
    heading !== null && activeTarget
      ? Math.abs((((activeTarget.bearing - heading) % 360) + 540) % 360 - 180)
      : null
  const isAligned = alignDiff !== null && alignDiff <= 8
  const hasSearchFeedback = searchStatus === 'empty' || searchStatus === 'error'

  const handleOpenCompass = async () => {
    setViewState('compass')

    if (!activeTarget) {
      setCompassStatus('unavailable')
      setCompassError('Pemancar TV belum ditemukan. Selesaikan pencarian lokasi terlebih dahulu.')
      return
    }

    if (compassStatus === 'available') {
      return
    }

    const fallbackDirection = `Gunakan arah ${Math.round(bearing)}° ${compassDirection}.`

    if (!isOrientationSupported) {
      setCompassStatus('unavailable')
      setCompassError(`Kompas tidak tersedia di perangkat ini. ${fallbackDirection}`)
      return
    }

    if (typeof window.DeviceOrientationEvent.requestPermission === 'function') {
      setCompassStatus('pending')
      try {
        const permission = await window.DeviceOrientationEvent.requestPermission()
        if (permission !== 'granted') {
          setCompassStatus('denied')
          setCompassError(`Izin kompas belum diberikan. ${fallbackDirection}`)
          return
        }
      } catch {
        setCompassStatus('denied')
        setCompassError(`Tidak bisa mengaktifkan kompas. ${fallbackDirection}`)
        return
      }
    }

    setCompassStatus('available')
    setCompassError(null)
  }

  const closeCompass = () => {
    setViewState('main')
    setCompassStatus('idle')
  }

  const resetToHome = () => {
    setLocation(null)
    setLocationStatus('idle')
    setLocationError(null)
    setTransmitters([])
    setSearchStatus('idle')
    setSearchMessage(null)
    setSelectedTransmitterId(null)
    setViewState('main')
    setCompassStatus('idle')
    setHeading(null)
    setCompassError(null)
    setAiScores({})
    setAiBestTransmitterId(null)
    setAiBestTransmitterReason(null)
    setAiSearchInput('')
    setAiSearchExplanation(null)
    setFilteredTransmitterIds(null)
    setSelectedCompareIds([])
    setAiCompareText(null)
    setAiError(null)
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand" onClick={resetToHome} style={{ cursor: 'pointer' }} title="Kembali ke Beranda">
          <div className="brand-logo">TV</div>
          <strong>TV Transmitter Finder</strong>
        </div>
        {locationStatus === 'success' && (
          <div className="gps-badge-container" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button type="button" className="btn-secondary btn-small" onClick={resetToHome}>
              ← Beranda
            </button>
            <div className="gps-badge">
              <span className="dot" />
              GPS Aktif
            </div>
          </div>
        )}
      </header>

      <main className="container">
        {showInitialState && (
          <section className="state-initial">
            <div className="hero-icon">🧭</div>
            <h1>Temukan Pemancar Terdekat</h1>
            <p>
              Gunakan GPS untuk mendeteksi lokasi stasiun pemancar TV digital terdekat dan arahkan antena Anda
              secara presisi.
            </p>
            <button type="button" className="btn-primary btn-large" onClick={() => void requestLocation()}>
              Mulai Cari Pemancar Terdekat
            </button>
          </section>
        )}

        {showLoadingState && (
          <section className="state-loading">
            <div className="spinner" aria-hidden="true" />
            <p className="loading-title">
              {locationStatus === 'loading'
                ? 'Mencari sinyal GPS...'
                : 'Mencari pemancar TV digital terdekat...'}
            </p>
            <p className="loading-subtitle">
              {locationStatus === 'loading'
                ? 'Izinkan akses lokasi pada peramban Anda'
                : 'Mencari koordinat menara transmisi dari database & satelit online'}
            </p>
          </section>
        )}

        {!showInitialState && !showLoadingState && (
          <section className="results">
            {isQuotaExceeded && (
              <div className="ai-quota-warning">
                <span className="quota-warning-icon">⚠️</span>
                <div className="quota-warning-content">
                  <strong>Kuota AI Gemini Habis (Limit 429)</strong>
                  <p>
                    Batas penggunaan API Gemini gratis Anda telah terlampaui. Karena token habis, maka data yang ditampilkan saat ini dialihkan secara otomatis berdasarkan <strong>kalkulasi offline dari database lokal ({transmitters.some(t => t.id >= 900001 && t.id <= 900042) ? 'transmitterSearch.ts (Preset Offline)' : 'Overpass API'})</strong>.
                  </p>
                </div>
              </div>
            )}

            {/* AI SEARCH INPUT BOX PANEL */}
            <article className="panel ai-search-panel">
              <p className="panel-tag ai-tag">🤖 AI Gemini Assistant</p>
              <h3>Pencarian Cerdas TV Digital</h3>
              <p className="subtle">Cari pemancar secara otomatis (default) atau ketik kueri Anda di bawah ini.</p>
              
              <form onSubmit={handleAISearch} className="ai-search-form">
                <input
                  type="text"
                  placeholder="Ketik e.g. 'Cari pemancar TVRI' atau 'Yang sinyalnya bagus untuk daerah saya'..."
                  value={aiSearchInput}
                  onChange={(e) => setAiSearchInput(e.target.value)}
                  className="ai-search-input"
                  disabled={isAISearching}
                />
                <button type="submit" className="btn-primary btn-ai" disabled={isAISearching || !aiSearchInput.trim()}>
                  {isAISearching ? 'Menganalisis...' : 'Tanya AI'}
                </button>
                {filteredTransmitterIds !== null && (
                  <button type="button" className="btn-secondary" onClick={handleResetAISearch}>
                    Reset
                  </button>
                )}
              </form>

              {aiSearchExplanation && (
                <div className="ai-search-explanation">
                  <span>ℹ️ Hasil AI:</span> {aiSearchExplanation}
                </div>
              )}
              {aiError && (
                <div className="ai-error-message">
                  ⚠️ {aiError}
                </div>
              )}
            </article>

            {/* AI BEST RECOMMENDATION PANEL */}
            {aiBestTransmitterReason && (
              <article className="panel ai-best-panel">
                <p className="panel-tag ai-best-tag">🏆 REKOMENDASI TERBAIK AI</p>
                <div className="ai-best-content">
                  <div className="ai-best-icon">🎯</div>
                  <div>
                    <h4>
                      {allRankedTransmitters.find((t) => t.transmitter.id === aiBestTransmitterId)?.transmitter.name || 'Menara Rekomendasi'}
                    </h4>
                    <p className="ai-best-text">"{aiBestTransmitterReason}"</p>
                  </div>
                </div>
              </article>
            )}

            {/* SELECTED TRANSMITTER MAIN PANEL */}
            <article className="panel main-panel">
              <div className="main-panel-body">
                <p className="panel-tag">Pemancar Terpilih</p>
                {activeTarget ? (
                  <>
                    <div className="ai-target-header">
                      <h2 className="ai-target-title">🏆 {activeTarget.transmitter.name}</h2>
                      <div className={`ai-score-badge ${getScoreClass(getAIScore(activeTarget))}`}>
                        {getAIScore(activeTarget)}/100
                      </div>
                    </div>
                    <p className="subtle">Analisis fisik pemancar berdasarkan lokasi Anda</p>
                    <div className="stats-grid">
                      <div className="stat-card">
                        <span className="stat-icon">📏</span>
                        <div>
                          <p className="stats-label">Jarak</p>
                          <p className="stats-val">{activeTarget.distanceKm.toFixed(1)} km</p>
                        </div>
                      </div>
                      <div className="stat-card">
                        <span className="stat-icon">🧭</span>
                        <div>
                          <p className="stats-label">Arah Azimuth</p>
                          <p className="stats-val">{Math.round(activeTarget.bearing)}° {getCompassDirection(activeTarget.bearing)}</p>
                        </div>
                      </div>
                      <div className="stat-card full-width">
                        <span className="stat-icon">📡</span>
                        <div>
                          <p className="stats-label">Rekomendasi</p>
                          <p className="stats-val brand-text">{getAIRecommendation(activeTarget)}</p>
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="feedback-block">
                    <p>
                      {hasSearchFeedback
                        ? searchMessage
                        : 'Pemancar TV di sekitar lokasi Anda tidak ditemukan.'}
                    </p>
                    {(locationStatus === 'denied' || locationStatus === 'error') && <p>{locationError}</p>}
                  </div>
                )}
              </div>
              <div className="panel-actions">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void handleOpenCompass()}
                  disabled={!activeTarget}
                >
                  Arahkan Antena
                </button>
                <button type="button" className="btn-secondary" onClick={() => void requestLocation()}>
                  Perbarui Lokasi
                </button>
              </div>
            </article>

            {/* MAP VIEW PANEL */}
            <article className="panel">
              <div className="panel-row">
                <p className="panel-row-title">Peta Jangkauan & Lokasi</p>
                <p className="coord-text">
                  {location
                    ? `Lat: ${location.latitude.toFixed(4)} | Lon: ${location.longitude.toFixed(4)}`
                    : 'Lat: - | Lon: -'}
                </p>
              </div>
              <MapView
                userLocation={location}
                rankedTransmitters={rankedTransmitters}
                selectedTransmitterId={selectedTransmitterId}
                onSelectTransmitter={(transmitterId) => setSelectedTransmitterId(transmitterId)}
              />
            </article>

            {/* ALTERNATIVE TRANSMITTERS PANEL */}
            <article className="panel">
              <h3>Pemancar Lain di Sekitar Anda</h3>
              <p className="subtle">Pilih pemancar di bawah untuk menjadikannya target utama, atau centang kotak di kanan untuk membandingkannya.</p>
              {alternatives.length === 0 && (
                <p className="subtle" style={{ marginTop: '10px' }}>Belum ada pemancar alternatif di hasil pencarian.</p>
              )}
              <div className="alt-list">
                {alternatives.map((item) => (
                  <div key={item.transmitter.id} className="alt-row-container">
                    <button
                      type="button"
                      className={`alt-item ${item.transmitter.id === selectedTransmitterId ? 'selected-item' : ''}`}
                      onClick={() => setSelectedTransmitterId(item.transmitter.id)}
                    >
                      <span>
                        <strong>🏆 {item.transmitter.name}</strong>
                        <small className="ai-small-score">
                          {getAIScore(item)}/100 | 📡 {getAIRecommendation(item)}
                        </small>
                      </span>
                      <span className="alt-metric">
                        {item.distanceKm.toFixed(1)} km
                        <small>
                          {Math.round(item.bearing)}° {getCompassDirection(item.bearing)}
                        </small>
                      </span>
                    </button>
                    <label className="compare-checkbox-label">
                      <input
                        type="checkbox"
                        checked={selectedCompareIds.includes(item.transmitter.id)}
                        onChange={() => handleToggleCompare(item.transmitter.id)}
                      />
                      <span>Bandingkan</span>
                    </label>
                  </div>
                ))}
              </div>

              {allRankedTransmitters.length >= 2 && (
                <div className="comparison-actions">
                  <span className="compare-info-text">
                    Centang minimal 2 pemancar alternatif di atas, lalu bandingkan:
                  </span>
                  <button
                    type="button"
                    className="btn-primary btn-compare"
                    onClick={() => void handleRunComparison()}
                    disabled={selectedCompareIds.length < 2 || isAIComparing}
                  >
                    {isAIComparing ? 'Menganalisis...' : `Bandingkan ${selectedCompareIds.length} Pemancar`}
                  </button>
                  {aiCompareText && (
                    <button type="button" className="btn-secondary" onClick={handleClearComparison}>
                      Reset Komparasi
                    </button>
                  )}
                </div>
              )}
            </article>

            {/* AI COMPARISON RESULT PANEL */}
            {aiCompareText && (
              <article className="panel ai-comparison-result-panel">
                <p className="panel-tag ai-tag">📊 Perbandingan Analisis AI</p>
                <h3>Hasil Komparasi Pemancar</h3>
                <div className="ai-comparison-body">
                  <MarkdownRenderer content={aiCompareText} />
                </div>
                <button type="button" className="btn-secondary" onClick={handleClearComparison} style={{ marginTop: '14px' }}>
                  Tutup Perbandingan
                </button>
              </article>
            )}
          </section>
        )}
      </main>

      <footer className="footer">TV Transmitter Finder © 2026. Navigasi Antena DVB-T2 Digital.</footer>

      {viewState === 'compass' && (
        <section className="compass-screen" role="dialog" aria-modal="true">
          <div className="compass-header">
            <button type="button" className="icon-button" onClick={closeCompass}>
              ←
            </button>
            <div className="compass-header-text">
              <p>Mode Antena</p>
              <strong>{activeTarget?.transmitter.name ?? 'Pemancar tidak tersedia'}</strong>
            </div>
            <span />
          </div>

          <div className="compass-body">
            {isAligned && <div className="aligned-badge">ANTENA SANGAT PRESISI</div>}

            <div className="compass-stage">
              <div className="compass-ring" />

              <div className="compass-rose" style={{ transform: `rotate(${compassRoseRotation}deg)` }}>
                <span className="north">N</span>
                <span className="east">E</span>
                <span className="south">S</span>
                <span className="west">W</span>

                <div className="target-pointer" style={{ transform: `rotate(${bearing}deg)` }}>
                  <div className="target-head">📺</div>
                  <div className="target-line" />
                </div>
              </div>

              <div className="center-hub">📱</div>
            </div>

            {activeTarget && (
              <div className="compass-readout">
                <p>
                  <span>Arah Pemancar:</span>
                  <strong>
                    {Math.round(activeTarget.bearing)}° {getCompassDirection(activeTarget.bearing)}
                  </strong>
                </p>
                <p>
                  <span>Heading Perangkat:</span>
                  <strong>{heading !== null ? `${Math.round(heading)}°` : 'Menunggu kompas'}</strong>
                </p>
                <p>
                  <span>Jarak:</span>
                  <strong>{formatDistanceKm(activeTarget.distanceKm)}</strong>
                </p>
              </div>
            )}

            <div className="compass-note">
              {(compassStatus === 'unavailable' || compassStatus === 'denied') && compassError ? (
                <p>{compassError}</p>
              ) : (
                <p>Putar perangkat hingga penanda pemancar berada di bagian atas layar.</p>
              )}

              {!isOrientationSupported && activeTarget && (
                <div className="simulator">
                  <label htmlFor="heading-slider">Simulasi Kompas (Desktop)</label>
                  <input
                    id="heading-slider"
                    type="range"
                    min={0}
                    max={360}
                    value={heading ?? 0}
                    onChange={(event) => setHeading(Number(event.target.value))}
                  />
                </div>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  )
}

export default App
