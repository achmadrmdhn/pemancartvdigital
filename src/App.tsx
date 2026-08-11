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
          const results = await searchNearbyTransmitters(nextLocation)
          setTransmitters(results)

          if (results.length === 0) {
            setSearchStatus('empty')
            setSearchMessage('Pemancar TV di sekitar lokasi Anda tidak ditemukan.')
            return
          }

          setSearchStatus('success')
          setSearchMessage(null)
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

  const rankedTransmitters = useMemo<RankedTransmitter[]>(() => {
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

  useEffect(() => {
    if (viewState !== 'compass' || compassStatus !== 'available') {
      return
    }

    const handleOrientation = (event: DeviceOrientationEvent) => {
      const orientationWithCompass = event as DeviceOrientationEvent & {
        webkitCompassHeading?: number
      }

      const nextHeading =
        typeof orientationWithCompass.webkitCompassHeading === 'number'
          ? orientationWithCompass.webkitCompassHeading
          : typeof event.alpha === 'number'
            ? event.alpha
            : null

      if (nextHeading !== null) {
        setHeading((360 - nextHeading + 360) % 360)
      }
    }

    window.addEventListener('deviceorientation', handleOrientation as EventListener, true)

    return () => {
      window.removeEventListener('deviceorientation', handleOrientation as EventListener, true)
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

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <div className="brand-logo">TV</div>
          <strong>TV Transmitter Finder</strong>
        </div>
        {locationStatus === 'success' && (
          <div className="gps-badge">
            <span className="dot" />
            GPS Aktif
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
              Gunakan Lokasi Saya
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
            <article className="panel main-panel">
              <div>
                <p className="panel-tag">Pemancar Terdekat</p>
                {activeTarget ? (
                  <>
                    <h2>{activeTarget.transmitter.name}</h2>
                    <p className="subtle">Data hasil pencarian online berdasarkan lokasi Anda</p>
                    <div className="stats">
                      <div>
                        <p className="stats-label">Jarak</p>
                        <p className="stats-value">
                          {activeTarget.distanceKm.toFixed(1)} <span>km</span>
                        </p>
                      </div>
                      <div className="stats-divider">
                        <p className="stats-label">Arah Azimuth</p>
                        <p className="stats-value brand">
                          {Math.round(activeTarget.bearing)}° <span>{getCompassDirection(activeTarget.bearing)}</span>
                        </p>
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

            <article className="panel">
              <h3>Pemancar Lain di Sekitar Anda</h3>
              {alternatives.length === 0 && (
                <p className="subtle">Belum ada pemancar alternatif di hasil pencarian.</p>
              )}
              <div className="alt-list">
                {alternatives.map((item) => (
                  <button
                    key={item.transmitter.id}
                    type="button"
                    className="alt-item"
                    onClick={() => setSelectedTransmitterId(item.transmitter.id)}
                  >
                    <span>
                      <strong>{item.transmitter.name}</strong>
                      <small>Hasil data geografis online</small>
                    </span>
                    <span className="alt-metric">
                      {item.distanceKm.toFixed(1)} km
                      <small>
                        {Math.round(item.bearing)}° {getCompassDirection(item.bearing)}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </article>
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
              <div className="compass-ring">
                <span className="north">N</span>
                <span className="east">E</span>
                <span className="south">S</span>
                <span className="west">W</span>
              </div>

              <div className="compass-rose" style={{ transform: `rotate(${compassRoseRotation}deg)` }}>
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
