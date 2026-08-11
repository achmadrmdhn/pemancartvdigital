export interface Transmitter {
  id: number
  name: string
  latitude: number
  longitude: number
  relevanceScore?: number
  sourceType?: 'node' | 'way' | 'relation'
}

export interface UserLocation {
  latitude: number
  longitude: number
  accuracy: number
}

export interface RankedTransmitter {
  transmitter: Transmitter
  distanceKm: number
  bearing: number
}
