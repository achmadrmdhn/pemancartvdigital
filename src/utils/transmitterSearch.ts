import type { Transmitter, UserLocation } from '../types'

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter'

interface OverpassElement {
  id: number
  lat?: number
  lon?: number
  center?: {
    lat?: number
    lon?: number
  }
  tags?: Record<string, string | undefined>
}

function getElementCoordinates(element: OverpassElement): { latitude: number; longitude: number } | null {
  if (typeof element.lat === 'number' && typeof element.lon === 'number') {
    return { latitude: element.lat, longitude: element.lon }
  }

  if (element.center && typeof element.center.lat === 'number' && typeof element.center.lon === 'number') {
    return { latitude: element.center.lat, longitude: element.center.lon }
  }

  return null
}

function buildName(tags: Record<string, string | undefined>) {
  if (tags.name) {
    return tags.name
  }

  if (tags.operator) {
    return tags.operator
  }

  if (tags['tower:type']) {
    return `Pemancar ${tags['tower:type']}`
  }

  return 'Pemancar TV sekitar'
}

export async function searchNearbyTransmitters(userLocation: UserLocation): Promise<Transmitter[]> {
  const query = `
[out:json][timeout:25];
(
  node["man_made"="mast"](around:5000,${userLocation.latitude},${userLocation.longitude});
  node["man_made"="antenna"](around:5000,${userLocation.latitude},${userLocation.longitude});
  node["tower:type"="communication"](around:5000,${userLocation.latitude},${userLocation.longitude});
  node["tower:type"="broadcast"](around:5000,${userLocation.latitude},${userLocation.longitude});
  way["man_made"="mast"](around:5000,${userLocation.latitude},${userLocation.longitude});
  way["man_made"="antenna"](around:5000,${userLocation.latitude},${userLocation.longitude});
  relation["man_made"="mast"](around:5000,${userLocation.latitude},${userLocation.longitude});
);
out center;
`

  const response = await fetch(`${OVERPASS_ENDPOINT}?data=${encodeURIComponent(query)}`)

  if (!response.ok) {
    throw new Error('Gagal mengambil data pemancar dari sumber online.')
  }

  const payload = (await response.json()) as {
    elements?: OverpassElement[]
  }

  const elements = payload.elements ?? []

  return elements
    .map((element) => {
      const coordinates = getElementCoordinates(element)
      if (!coordinates) {
        return null
      }

      const tags = element.tags ?? {}
      const name = buildName(tags)

      return {
        id: element.id,
        name,
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
      } satisfies Transmitter
    })
    .filter((item): item is Transmitter => item !== null)
}
