import type { Transmitter, UserLocation } from '../types'

const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search'
const TRANSMITTER_NAME_PATTERN =
  'pemancar|transmisi|transmitter|relay|broadcast|siaran|digital|mux|tv|televisi|television|tvri|rcti|sctv|indosiar|metro|trans|antv|tvone|mnc|global|inews|rtv|net|kompas|btv|vtv|jtv|muxtv'

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
  // Strictly require the feature to be a physical tower/mast or have broadcast markers
  const isTower = tags.man_made === 'tower' || tags.man_made === 'mast' || tags['tower:type']
  const isBroadcast = tags.broadcast || tags['communication:television']
  if (!isTower && !isBroadcast) {
    return 0
  }

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

  return score
}

async function queryOverpass(userLocation: UserLocation, radiusMeters: number) {
  const query = `
[out:json][timeout:25];
(
  node["name"~"${TRANSMITTER_NAME_PATTERN}",i](around:${radiusMeters},${userLocation.latitude},${userLocation.longitude});
  way["name"~"${TRANSMITTER_NAME_PATTERN}",i](around:${radiusMeters},${userLocation.latitude},${userLocation.longitude});

  node["broadcast"~"tv|television|dvb|digital",i](around:${radiusMeters},${userLocation.latitude},${userLocation.longitude});
  way["broadcast"~"tv|television|dvb|digital",i](around:${radiusMeters},${userLocation.latitude},${userLocation.longitude});

  node["communication:television"~"yes|main|primary|transmitter|broadcast",i](around:${radiusMeters},${userLocation.latitude},${userLocation.longitude});
  way["communication:television"~"yes|main|primary|transmitter|broadcast",i](around:${radiusMeters},${userLocation.latitude},${userLocation.longitude});

  node["tower:type"~"broadcast|communication",i](around:${radiusMeters},${userLocation.latitude},${userLocation.longitude});
  way["tower:type"~"broadcast|communication",i](around:${radiusMeters},${userLocation.latitude},${userLocation.longitude});
);
out center tags;
`

  const endpoints = [
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.nchc.org.tw/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
    'https://z.overpass-api.de/api/interpreter',
  ]

  let lastError: unknown = null
  for (const endpoint of endpoints) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000)
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
    'TVRI',
    'RCTI',
    'SCTV',
    'Indosiar',
    'stasiun transmisi',
    'pemancar tv',
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

  const VALID_TRANSMITTER_NAME_REGEX = /pemancar|transmisi|transmitter|relay|siaran|digital|mux|tv|televisi|television|tvri|rcti|sctv|indosiar|metro|trans|antv|tvone|mnc|global|inews|rtv|net|kompas|btv|vtv|jtv/i

  const mapped: Array<Transmitter | null> = results.map((item) => {
    const latitude = Number(item.lat)
    const longitude = Number(item.lon)
    const name = getMapNameFromDisplay(item.display_name)

    if (!name || Number.isNaN(latitude) || Number.isNaN(longitude)) {
      return null
    }

    // Exclude known corporate office towers or non-transmitters
    if (/tower/i.test(name)) {
      return null
    }

    if (!VALID_TRANSMITTER_NAME_REGEX.test(name)) {
      return null
    }

    const category = (item.class ?? item.category ?? '').toLowerCase()
    const type = (item.type ?? '').toLowerCase()

    // Strictly require it to be a physical tower or mast (man_made=tower/mast)
    if (category !== 'man_made' || !['tower', 'mast'].includes(type)) {
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
  // JAKARTA & TANGERANG SELATAN (PUSAT / BARAT)
  { id: 900001, name: 'Stasiun Pemancar TVRI Joglo (Jakarta Barat)', latitude: -6.2223, longitude: 106.7324, relevanceScore: 200, sourceType: 'node' },
  { id: 900002, name: 'Menara Pemancar RCTI / MNC Media Kebon Jeruk (Jakarta Barat)', latitude: -6.1911, longitude: 106.7666, relevanceScore: 190, sourceType: 'node' },
  { id: 900003, name: 'Menara Pemancar Indosiar / Emtek Duri Kepa (Jakarta Barat)', latitude: -6.1656, longitude: 106.7781, relevanceScore: 190, sourceType: 'node' },
  { id: 900004, name: 'Stasiun Transmisi TVRI Pusat Senayan (Jakarta Selatan)', latitude: -6.2129, longitude: 106.8010, relevanceScore: 180, sourceType: 'node' },
  { id: 900005, name: 'Menara Pemancar Metro TV / Media Group Kedoya (Jakarta Barat)', latitude: -6.1652, longitude: 106.7588, relevanceScore: 190, sourceType: 'node' },
  { id: 900006, name: 'Menara Trans TV / Transmedia Tendean (Jakarta Selatan)', latitude: -6.2408, longitude: 106.8315, relevanceScore: 180, sourceType: 'node' },
  { id: 900007, name: 'Stasiun Pemancar tvOne / Viva Group Pulogadung (Jakarta Timur)', latitude: -6.1887, longitude: 106.9023, relevanceScore: 180, sourceType: 'node' },
  { id: 900008, name: 'Stasiun Transmisi RTV / Rajawali Cawang (Jakarta Timur)', latitude: -6.2464, longitude: 106.8689, relevanceScore: 170, sourceType: 'node' },
  { id: 900009, name: 'Stasiun Pemancar Kompas TV Palmerah (Jakarta Pusat)', latitude: -6.2081, longitude: 106.7972, relevanceScore: 170, sourceType: 'node' },
  { id: 900010, name: 'Stasiun Pemancar NET. TV / MD Entertainment Setiabudi (Jakarta Selatan)', latitude: -6.2098, longitude: 106.8298, relevanceScore: 170, sourceType: 'node' },
  { id: 900011, name: 'Stasiun Transmisi DAAI TV Pantai Indah Kapuk (Jakarta Utara)', latitude: -6.1118, longitude: 106.7385, relevanceScore: 160, sourceType: 'node' },

  // BOGOR (GUNUNG GEULIS & SEKITARNYA)
  { id: 900020, name: 'Stasiun Pemancar TVRI MUX Gunung Geulis (Bogor)', latitude: -6.6192, longitude: 106.8831, relevanceScore: 200, sourceType: 'node' },
  { id: 900021, name: 'Stasiun Transmisi RCTI / MNC Gunung Geulis (Bogor)', latitude: -6.6195, longitude: 106.8845, relevanceScore: 190, sourceType: 'node' },
  { id: 900022, name: 'Stasiun Transmisi SCTV / Emtek Gunung Geulis (Bogor)', latitude: -6.6201, longitude: 106.8850, relevanceScore: 190, sourceType: 'node' },
  { id: 900023, name: 'Stasiun Transmisi Metro TV Gunung Geulis (Bogor)', latitude: -6.6185, longitude: 106.8820, relevanceScore: 180, sourceType: 'node' },
  { id: 900024, name: 'Stasiun Transmisi tvOne / Viva Gunung Bunder (Bogor)', latitude: -6.6781, longitude: 106.6892, relevanceScore: 180, sourceType: 'node' },
  { id: 900025, name: 'Stasiun Pemancar TVRI Gunung Salak / Cimelati (Bogor)', latitude: -6.7125, longitude: 106.7918, relevanceScore: 180, sourceType: 'node' },

  // TANGERANG & BANTEN UTARA (LEBAK/TANGERANG)
  { id: 900030, name: 'Stasiun Transmisi TVRI Tangerang Kota', latitude: -6.2167, longitude: 106.6333, relevanceScore: 190, sourceType: 'node' },
  { id: 900031, name: 'Stasiun Pemancar TVRI MUX Serpong (Tangerang Selatan)', latitude: -6.3021, longitude: 106.6714, relevanceScore: 180, sourceType: 'node' },
  { id: 900032, name: 'Stasiun Transmisi MUX Metro TV Pasir Kemis (Tangerang)', latitude: -6.1689, longitude: 106.5412, relevanceScore: 170, sourceType: 'node' },
  { id: 900033, name: 'Stasiun Pemancar TVRI Banten / MUX Gunung Karang (Pandeglang/Serang)', latitude: -6.3042, longitude: 106.0511, relevanceScore: 180, sourceType: 'node' },

  // BEKASI & DEPOK
  { id: 900040, name: 'Stasiun Pemancar MUX TVRI Tambun (Bekasi)', latitude: -6.2625, longitude: 107.0611, relevanceScore: 180, sourceType: 'node' },
  { id: 900041, name: 'Stasiun Transmisi Relay TVRI Sawangan (Depok)', latitude: -6.3982, longitude: 106.7725, relevanceScore: 170, sourceType: 'node' },
  { id: 900042, name: 'Stasiun Relay Pemancar Cikarang (Bekasi Timur)', latitude: -6.3051, longitude: 107.1528, relevanceScore: 160, sourceType: 'node' },
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

    // Exclude known corporate office towers or non-transmitters
    if (/mnc tower|menara mnc|mnc center|mnc plaza|mnc studios|sctv tower|trans tv tendean|menara kominfo|kominfo cibinong/i.test(mapName)) {
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
