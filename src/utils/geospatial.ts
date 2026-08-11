import type { Transmitter, UserLocation } from '../types'

export function calculateDistanceKm(userLocation: UserLocation, transmitter: Transmitter) {
  const toRadians = (value: number) => (value * Math.PI) / 180

  const earthRadiusKm = 6371
  const deltaLat = toRadians(transmitter.latitude - userLocation.latitude)
  const deltaLng = toRadians(transmitter.longitude - userLocation.longitude)

  const lat1 = toRadians(userLocation.latitude)
  const lat2 = toRadians(transmitter.latitude)

  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2)

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return earthRadiusKm * c
}

export function calculateBearing(userLocation: UserLocation, transmitter: Transmitter) {
  const lat1 = (Math.PI / 180) * userLocation.latitude
  const lat2 = (Math.PI / 180) * transmitter.latitude
  const deltaLng = (Math.PI / 180) * (transmitter.longitude - userLocation.longitude)

  const y = Math.sin(deltaLng) * Math.cos(lat2)
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng)

  const bearing = (Math.atan2(y, x) * 180) / Math.PI
  return (bearing + 360) % 360
}

export function getCompassDirection(degree: number) {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const index = Math.round(degree / 45) % directions.length
  const normalizedIndex = (index + directions.length) % directions.length
  return directions[normalizedIndex]
}

export function formatDistanceKm(distanceKm: number) {
  return `${distanceKm.toFixed(1)} km`
}
