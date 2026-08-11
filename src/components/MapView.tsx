import { useEffect } from 'react'
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import type { LatLngExpression } from 'leaflet'
import type { Transmitter, UserLocation } from '../types'

interface MapViewProps {
  userLocation: UserLocation | null
  transmitter: Transmitter | null
  distanceKm: number | null
  bearing: number | null
}

const userIcon = L.divIcon({
  html: '<span class="map-marker user-marker"><span class="inner-dot"></span></span>',
  className: 'marker-bubble',
  iconSize: [20, 20],
})

const transmitterIcon = L.divIcon({
  html: '<span class="map-marker transmitter-marker">📡</span>',
  className: 'marker-bubble',
  iconSize: [32, 32],
})

function MapViewport({ userLocation, transmitter }: Pick<MapViewProps, 'userLocation' | 'transmitter'>) {
  const map = useMap()

  useEffect(() => {
    if (userLocation && transmitter) {
      const bounds = L.latLngBounds(
        [userLocation.latitude, userLocation.longitude],
        [transmitter.latitude, transmitter.longitude],
      )
      map.fitBounds(bounds, { padding: [40, 40] })
      return
    }

    if (userLocation) {
      map.setView([userLocation.latitude, userLocation.longitude], 12)
    }
  }, [map, transmitter, userLocation])

  return null
}

export function MapView({ userLocation, transmitter, distanceKm, bearing }: MapViewProps) {
  const center: LatLngExpression = userLocation
    ? [userLocation.latitude, userLocation.longitude]
    : [-6.595, 106.816]

  if (!userLocation || !transmitter) {
    return (
      <div className="map-placeholder">
        <p>Menunggu lokasi Anda agar peta bisa ditampilkan.</p>
      </div>
    )
  }

  const route: LatLngExpression[] = [
    [userLocation.latitude, userLocation.longitude],
    [transmitter.latitude, transmitter.longitude],
  ]

  return (
    <div className="map-wrap">
      <MapContainer center={center} zoom={11} scrollWheelZoom={false} className="map-container">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <MapViewport userLocation={userLocation} transmitter={transmitter} />
        <Marker position={[userLocation.latitude, userLocation.longitude]} icon={userIcon}>
          <Popup>Posisi Anda</Popup>
        </Marker>
        <Marker position={[transmitter.latitude, transmitter.longitude]} icon={transmitterIcon}>
          <Popup>
            <strong>{transmitter.name}</strong>
            {distanceKm !== null && bearing !== null && (
              <>
                <br />
                {distanceKm.toFixed(1)} km ({Math.round(bearing)}°)
              </>
            )}
          </Popup>
        </Marker>
        <Polyline positions={route} pathOptions={{ color: '#2563eb', weight: 3, dashArray: '6 8', opacity: 0.85 }} />
      </MapContainer>
    </div>
  )
}
