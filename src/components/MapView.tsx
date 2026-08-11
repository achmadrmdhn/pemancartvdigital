import { useEffect, useMemo } from 'react'
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import type { LatLngExpression } from 'leaflet'
import type { RankedTransmitter, UserLocation } from '../types'

interface MapViewProps {
  userLocation: UserLocation | null
  rankedTransmitters: RankedTransmitter[]
  selectedTransmitterId: number | null
  onSelectTransmitter: (transmitterId: number) => void
}

const userIcon = L.divIcon({
  html: '<span class="map-marker user-marker"><span class="inner-dot"></span></span>',
  className: 'marker-bubble',
  iconSize: [20, 20],
})

function createTransmitterIcon(isSelected: boolean) {
  return L.divIcon({
    html: `<span class="map-marker transmitter-marker ${isSelected ? 'selected' : ''}">📡</span>`,
    className: 'marker-bubble',
    iconSize: [32, 32],
  })
}

function MapViewport({
  userLocation,
  rankedTransmitters,
}: Pick<MapViewProps, 'userLocation' | 'rankedTransmitters'>) {
  const map = useMap()
  const boundsKey = useMemo(
    () => rankedTransmitters.map((item) => item.transmitter.id).join(':'),
    [rankedTransmitters],
  )

  useEffect(() => {
    if (!userLocation) {
      return
    }

    if (rankedTransmitters.length === 0) {
      map.setView([userLocation.latitude, userLocation.longitude], 12)
      return
    }

    const points: LatLngExpression[] = [
      [userLocation.latitude, userLocation.longitude],
      ...rankedTransmitters.map((item) => [item.transmitter.latitude, item.transmitter.longitude] as LatLngExpression),
    ]
    const bounds = L.latLngBounds(points as [number, number][])
    map.fitBounds(bounds, { padding: [40, 40] })
  }, [map, userLocation, boundsKey, rankedTransmitters])

  return null
}

export function MapView({
  userLocation,
  rankedTransmitters,
  selectedTransmitterId,
  onSelectTransmitter,
}: MapViewProps) {
  const center: LatLngExpression = userLocation
    ? [userLocation.latitude, userLocation.longitude]
    : [-6.595, 106.816]

  if (!userLocation) {
    return (
      <div className="map-placeholder">
        <p>Menunggu lokasi Anda agar peta bisa ditampilkan.</p>
      </div>
    )
  }

  const activeTarget =
    rankedTransmitters.find((item) => item.transmitter.id === selectedTransmitterId) ?? rankedTransmitters[0] ?? null

  const route: LatLngExpression[] | null = activeTarget
    ? [
        [userLocation.latitude, userLocation.longitude],
        [activeTarget.transmitter.latitude, activeTarget.transmitter.longitude],
      ]
    : null

  return (
    <div className="map-wrap">
      <MapContainer center={center} zoom={11} scrollWheelZoom className="map-container">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <MapViewport userLocation={userLocation} rankedTransmitters={rankedTransmitters} />

        <Marker position={[userLocation.latitude, userLocation.longitude]} icon={userIcon}>
          <Popup>Posisi Anda</Popup>
        </Marker>

        {rankedTransmitters.map((item) => {
          const isSelected = item.transmitter.id === activeTarget?.transmitter.id
          return (
            <Marker
              key={item.transmitter.id}
              position={[item.transmitter.latitude, item.transmitter.longitude]}
              icon={createTransmitterIcon(isSelected)}
              eventHandlers={{
                click: () => onSelectTransmitter(item.transmitter.id),
              }}
            >
              <Popup>
                <strong>{item.transmitter.name}</strong>
                <br />
                {item.distanceKm.toFixed(1)} km ({Math.round(item.bearing)}°)
                <br />
                Klik marker untuk memilih pemancar ini.
              </Popup>
            </Marker>
          )
        })}

        {route && <Polyline positions={route} pathOptions={{ color: '#2563eb', weight: 3, dashArray: '6 8', opacity: 0.85 }} />}
      </MapContainer>
    </div>
  )
}
