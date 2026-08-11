import type { Transmitter, UserLocation } from '../types'

const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search'
const TRANSMITTER_NAME_PATTERN =
  'pemancar|transmisi|transmitter|relay\\s?tv|menara\\s?tv|tv\\s?tower|television\\s?tower|stasiun\\s?tv|stasiun\\s?televisi|tvri|rcti|sctv|indosiar|metro\\s?tv|trans\\s?tv|trans7|mnc\\s?tv|antv|tvone|g\\s?tv|global\\s?tv'

interface OverpassElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  center?: {
    lat?: number
    lon?: number
  }
  tags?: Record<string, string | undefined>
}

interface NominatimItem {
  place_id: number
  display_name: string
  lat: string
  lon: string
  type?: string
  class?: string
  category?: string
}

function toRadians(value: number) {
  return (value * Math.PI) / 180
}

function calculateDistanceKm(from: UserLocation, to: { latitude: number; longitude: number }) {
  const earthRadiusKm = 6371
  const deltaLat = toRadians(to.latitude - from.latitude)
  const deltaLng = toRadians(to.longitude - from.longitude)
  const lat1 = toRadians(from.latitude)
  const lat2 = toRadians(to.latitude)
  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return earthRadiusKm * c
}

function stringToId(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index)
    hash |= 0
  }

  return Math.abs(hash)
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

function getMapName(tags: Record<string, string | undefined>) {
  const candidates = [tags.name, tags['name:id'], tags['name:en'], tags['name:ms']]

  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }

  return null
}

function computeRelevanceScore(tags: Record<string, string | undefined>) {
  const textBlob = [
    tags.name,
    tags.operator,
    tags.network,
    tags.brand,
    tags.broadcast,
    tags.content,
    tags.description,
    tags.note,
    tags['tower:type'],
    tags['communication:television'],
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  let score = 0

  if (new RegExp(TRANSMITTER_NAME_PATTERN, 'i').test(textBlob)) {
    score += 100
  }

  const broadcast = (tags.broadcast ?? '').toLowerCase()
  if (/tv|television|dvb|digital/.test(broadcast)) {
    score += 120
  }

  const communicationTv = (tags['communication:television'] ?? '').toLowerCase()
  if (/yes|main|primary|transmitter|broadcast/.test(communicationTv)) {
    score += 110
  }

  const towerType = (tags['tower:type'] ?? '').toLowerCase()
  if (/broadcast/.test(towerType)) {
    score += 85
  }
  if (/communication/.test(towerType)) {
    score += 35
  }
  if (/cell|mobile|gsm|lte/.test(towerType)) {
    score -= 120
  }

  const communicationMobile = (tags['communication:mobile_phone'] ?? '').toLowerCase()
  if (/yes|true|main|primary/.test(communicationMobile)) {
    score -= 90
  }

  const nameText = (tags.name ?? '').toLowerCase()
  if (new RegExp(TRANSMITTER_NAME_PATTERN, 'i').test(nameText)) {
    score += 75
  }

  // Exclude commercial shops, repair services, or unrelated POIs
  if (tags.shop || tags.craft || (tags.amenity && !/television|broadcast|studio/.test(tags.amenity))) {
    score -= 200
  }

  // Reduce score for plain buildings or offices with no tower/broadcast markers
  const isTower = tags.man_made === 'tower' || tags.man_made === 'mast' || tags['tower:type']
  const isBroadcast = tags.broadcast || tags['communication:television']
  if (!isTower && !isBroadcast && (tags.office || tags.building)) {
    score -= 80
  }

  return score
}

async function queryOverpass(userLocation: UserLocation, radiusMeters: number) {
  const query = `
[out:json][timeout:25];
(
  node["name"~"${TRANSMITTER_NAME_PATTERN}",i](around:${radiusMeters},${userLocation.latitude},${userLocation.longitude});
  way["name"~"${TRANSMITTER_NAME_PATTERN}",i](around:${radiusMeters},${userLocation.latitude},${userLocation.longitude});
  relation["name"~"${TRANSMITTER_NAME_PATTERN}",i](around:${radiusMeters},${userLocation.latitude},${userLocation.longitude});

  node["broadcast"~"tv|television|dvb|digital",i](around:${radiusMeters},${userLocation.latitude},${userLocation.longitude});
  way["broadcast"~"tv|television|dvb|digital",i](around:${radiusMeters},${userLocation.latitude},${userLocation.longitude});
  relation["broadcast"~"tv|television|dvb|digital",i](around:${radiusMeters},${userLocation.latitude},${userLocation.longitude});

  node["communication:television"~"yes|main|primary|transmitter|broadcast",i](around:${radiusMeters},${userLocation.latitude},${userLocation.longitude});
  way["communication:television"~"yes|main|primary|transmitter|broadcast",i](around:${radiusMeters},${userLocation.latitude},${userLocation.longitude});
  relation["communication:television"~"yes|main|primary|transmitter|broadcast",i](around:${radiusMeters},${userLocation.latitude},${userLocation.longitude});

  node["tower:type"~"broadcast|communication",i](around:${radiusMeters},${userLocation.latitude},${userLocation.longitude});
  way["tower:type"~"broadcast|communication",i](around:${radiusMeters},${userLocation.latitude},${userLocation.longitude});
);
out center tags;
`

  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
    'https://z.overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ]

  let lastError: unknown = null
  for (const endpoint of endpoints) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 6000)
      const response = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, {
        signal: controller.signal
      })
      clearTimeout(timeoutId)

      if (response.ok) {
        const payload = (await response.json()) as {
          elements?: OverpassElement[]
        }
        return payload.elements ?? []
      }
    } catch (error) {
      lastError = error
    }
  }

  throw lastError ?? new Error('Gagal mengambil data pemancar dari Overpass.')
}

function dedupeByLocationAndName(transmitters: Transmitter[]) {
  const map = new Map<string, Transmitter>()

  for (const transmitter of transmitters) {
    const latKey = transmitter.latitude.toFixed(4)
    const lonKey = transmitter.longitude.toFixed(4)
    const key = `${latKey}:${lonKey}:${transmitter.name.toLowerCase()}`
    const current = map.get(key)

    if (!current || (transmitter.relevanceScore ?? 0) > (current.relevanceScore ?? 0)) {
      map.set(key, transmitter)
    }
  }

  return [...map.values()]
}

async function fetchOverpassCandidates(userLocation: UserLocation) {
  const attempts = await Promise.allSettled([
    queryOverpass(userLocation, 12000),
    queryOverpass(userLocation, 30000),
  ])

  const fulfilled = attempts
    .filter((result): result is PromiseFulfilledResult<OverpassElement[]> => result.status === 'fulfilled')
    .flatMap((result) => result.value)

  if (fulfilled.length === 0) {
    throw new Error('Gagal mengambil data pemancar dari Overpass.')
  }

  return fulfilled
}

function getMapNameFromDisplay(displayName: string) {
  const head = displayName.split(',')[0]?.trim()
  return head && head.length > 0 ? head : null
}

async function queryNominatimByKeyword(userLocation: UserLocation, keyword: string, limit = 8) {
  const latDelta = 0.45
  const lonDelta = 0.45 / Math.max(Math.cos(toRadians(userLocation.latitude)), 0.2)

  const params = new URLSearchParams({
    format: 'jsonv2',
    q: keyword,
    limit: String(limit),
    bounded: '1',
    viewbox: `${userLocation.longitude - lonDelta},${userLocation.latitude + latDelta},${userLocation.longitude + lonDelta},${userLocation.latitude - latDelta}`,
    addressdetails: '0',
  })

  const response = await fetch(`${NOMINATIM_ENDPOINT}?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(`Gagal mengambil data pencarian "${keyword}" dari Nominatim.`)
  }

  return (await response.json()) as NominatimItem[]
}

function computeNominatimRelevance(item: NominatimItem) {
  const category = item.class ?? item.category ?? ''
  const type = item.type ?? ''
  const text = `${item.display_name} ${type} ${category}`.toLowerCase()
  let score = 0

  if (new RegExp(TRANSMITTER_NAME_PATTERN, 'i').test(text)) {
    score += 120
  }
  if (/tower|mast|antenna|station/.test(text)) {
    score += 35
  }
  if (/cell|mobile|gsm|lte/.test(text)) {
    score -= 70
  }

  return score
}

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchNominatimFallback(userLocation: UserLocation) {
  const keywords = [
    'pemancar tv',
    'transmisi tv',
    'tv transmitter',
    'pemancar TVRI',
  ]

  const results: NominatimItem[] = []
  
  for (const keyword of keywords) {
    try {
      const items = await queryNominatimByKeyword(userLocation, keyword)
      if (items && items.length > 0) {
        results.push(...items)
      }
    } catch (error) {
      console.warn(`Failed to query Nominatim for "${keyword}":`, error)
    }

    // Stop querying if we have already found enough potential candidates
    // to save user time and avoid hitting API rate limits.
    if (results.length >= 50) {
      break
    }
    
    // Respect Nominatim's strict rate limit policy (max 1 request per second)
    await delay(1100)
  }

  const mapped: Array<Transmitter | null> = results.map((item) => {
      const latitude = Number(item.lat)
      const longitude = Number(item.lon)
      const name = getMapNameFromDisplay(item.display_name)

      if (!name || Number.isNaN(latitude) || Number.isNaN(longitude)) {
        return null
      }

      const category = (item.class ?? item.category ?? '').toLowerCase()
      const type = (item.type ?? '').toLowerCase()

      // Filter out roads, bus stops, boundaries, waterways, natural features
      if (['highway', 'boundary', 'place', 'waterway', 'natural'].includes(category)) {
        return null
      }
      if (['bus_stop', 'bus_station', 'railway_station', 'platform'].includes(type)) {
        return null
      }

      const candidate: Transmitter = {
        id: stringToId(`nominatim:${item.place_id}:${name}:${latitude}:${longitude}`),
        name,
        latitude,
        longitude,
        relevanceScore: computeNominatimRelevance(item),
      }

      return candidate
    })

  return mapped.filter((item): item is Transmitter => item !== null)
}

const PRESET_TRANSMITTERS: Transmitter[] = [
  // JABODETABEK
  { id: 900001, name: 'Stasiun Pemancar TVRI Joglo (Jakarta)', latitude: -6.2223, longitude: 106.7324, relevanceScore: 200, sourceType: 'node' },
  { id: 900002, name: 'Menara Pemancar RCTI Kebon Jeruk (Jakarta)', latitude: -6.1911, longitude: 106.7666, relevanceScore: 190, sourceType: 'node' },
  { id: 900003, name: 'Menara Pemancar Indosiar Duri Kepa (Jakarta)', latitude: -6.1656, longitude: 106.7781, relevanceScore: 180, sourceType: 'node' },
  { id: 900004, name: 'Stasiun Transmisi TVRI Senayan (Jakarta)', latitude: -6.2129, longitude: 106.8010, relevanceScore: 170, sourceType: 'node' },
  // BANDUNG
  { id: 900005, name: 'Stasiun Pemancar TVRI Panyandakan (Bandung)', latitude: -6.8149, longitude: 107.5599, relevanceScore: 200, sourceType: 'node' },
  { id: 900006, name: 'Stasiun Transmisi RCTI Bandung', latitude: -6.8132, longitude: 107.5612, relevanceScore: 190, sourceType: 'node' },
  // YOGYAKARTA & SOLO
  { id: 900007, name: 'Stasiun Pemancar TVRI Patuk (Yogyakarta)', latitude: -7.8488, longitude: 110.4851, relevanceScore: 200, sourceType: 'node' },
  { id: 900008, name: 'Stasiun Transmisi RCTI Patuk (Yogyakarta)', latitude: -7.8492, longitude: 110.4862, relevanceScore: 190, sourceType: 'node' },
  // SEMARANG
  { id: 900009, name: 'Stasiun Pemancar TVRI Gombel (Semarang)', latitude: -7.0385, longitude: 110.4223, relevanceScore: 200, sourceType: 'node' },
  { id: 900010, name: 'Stasiun Transmisi RCTI Gombel (Semarang)', latitude: -7.0392, longitude: 110.4241, relevanceScore: 190, sourceType: 'node' },
  // SURABAYA
  { id: 900011, name: 'Stasiun Pemancar TVRI Surabaya', latitude: -7.2917, longitude: 112.7161, relevanceScore: 200, sourceType: 'node' },
  { id: 900012, name: 'Stasiun Transmisi RCTI Surabaya', latitude: -7.2882, longitude: 112.7125, relevanceScore: 190, sourceType: 'node' },
  // MEDAN
  { id: 900013, name: 'Stasiun Pemancar TVRI Bandar Baru (Medan)', latitude: 3.2568, longitude: 98.5471, relevanceScore: 200, sourceType: 'node' },
  // MAKASSAR
  { id: 900014, name: 'Stasiun Pemancar TVRI Makassar', latitude: -5.1432, longitude: 119.4211, relevanceScore: 200, sourceType: 'node' },
  // BALI
  { id: 900015, name: 'Stasiun Pemancar TVRI Bukit Bakung (Jimbaran/Bali)', latitude: -8.8151, longitude: 115.1612, relevanceScore: 200, sourceType: 'node' },
]

function getPresetCandidates(userLocation: UserLocation, maxDistanceKm = 60): Transmitter[] {
  return PRESET_TRANSMITTERS.filter((preset) => {
    const dist = calculateDistanceKm(userLocation, { latitude: preset.latitude, longitude: preset.longitude })
    return dist <= maxDistanceKm
  })
}

export async function searchNearbyTransmitters(userLocation: UserLocation): Promise<Transmitter[]> {
  let overpassElements: OverpassElement[] = []
  let overpassFailed = false

  try {
    overpassElements = await fetchOverpassCandidates(userLocation)
  } catch {
    overpassFailed = true
  }

  const mappedOverpass: Array<Transmitter | null> = overpassElements.map((element) => {
    const coordinates = getElementCoordinates(element)
    if (!coordinates) {
      return null
    }

    const tags = element.tags ?? {}
    const mapName = getMapName(tags)
    if (!mapName) {
      return null
    }

    const relevanceScore = computeRelevanceScore(tags)

    const candidate: Transmitter = {
      id: Number(`${element.type === 'node' ? 1 : element.type === 'way' ? 2 : 3}${element.id}`),
      name: mapName,
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      relevanceScore,
      sourceType: element.type,
    }

    return candidate
  })

  const overpassCandidates = mappedOverpass.filter((item): item is Transmitter => item !== null)
  const dedupedOverpass = dedupeByLocationAndName(overpassCandidates)
  const rankedOverpass = dedupedOverpass.filter((item) => (item.relevanceScore ?? 0) >= 20)

  const combined = [...rankedOverpass]

  // Add relevant offline preset transmitters if the user is within range (60 km)
  const presetCandidates = getPresetCandidates(userLocation, 60)
  combined.push(...presetCandidates)

  // Fetch online fallback from Nominatim if we have very few results or Overpass failed
  if (combined.length < 3 || overpassFailed) {
    try {
      const fallbackCandidates = await fetchNominatimFallback(userLocation)
      combined.push(...fallbackCandidates)
    } catch (e) {
      console.warn('Nominatim fallback failed:', e)
    }
  }

  const dedupedCombined = dedupeByLocationAndName(combined)
  if (dedupedCombined.length === 0) {
    throw new Error('Pemancar TV di sekitar lokasi Anda tidak ditemukan.')
  }

  return dedupedCombined
    .sort((left, right) => {
      const distanceA = calculateDistanceKm(userLocation, { latitude: left.latitude, longitude: left.longitude })
      const distanceB = calculateDistanceKm(userLocation, { latitude: right.latitude, longitude: right.longitude })
      if (distanceA !== distanceB) {
        return distanceA - distanceB
      }

      return (right.relevanceScore ?? 0) - (left.relevanceScore ?? 0)
    })
    .slice(0, 150)
}
