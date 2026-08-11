export interface Transmitter {
  id: number
  name: string
  latitude: number
  longitude: number
}

export interface UserLocation {
  latitude: number
  longitude: number
  accuracy: number
}
