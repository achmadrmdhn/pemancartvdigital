import type { RankedTransmitter, Transmitter, UserLocation } from '../types'
import { getCompassDirection } from './geospatial'

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'

export function isGeminiConfigured(): boolean {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY
  return typeof apiKey === 'string' && apiKey.trim().length > 0 && apiKey !== 'YOUR_GEMINI_API_KEY_HERE'
}

let quotaCallback: (() => void) | null = null

export function setQuotaCallback(cb: () => void) {
  quotaCallback = cb
}

async function callGemini(prompt: string, isJson = false): Promise<string> {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY
  if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    throw new Error('API Key Gemini belum dikonfigurasi. Silakan isi VITE_GEMINI_API_KEY di file .env')
  }

  const url = `${GEMINI_API_URL}?key=${apiKey}`
  const body: any = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ]
  }

  if (isJson) {
    body.generationConfig = {
      responseMimeType: 'application/json'
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    if (response.status === 429) {
      quotaCallback?.()
    }
    const errorDetails = await response.text().catch(() => '')
    throw new Error(`API Gemini error (Status ${response.status}): ${errorDetails || response.statusText}`)
  }

  const payload = await response.json()
  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text
  if (typeof text !== 'string') {
    throw new Error('Gagal mendapatkan respon teks dari API Gemini.')
  }

  return text
}

interface ScoreResult {
  scores: Array<{
    id: number
    score: number
    recommendation: string
  }>
  bestTransmitterId: number | null
  bestTransmitterReason: string
}

export async function generateAIScoresAndRecommendations(
  userLocation: UserLocation,
  transmitters: RankedTransmitter[]
): Promise<ScoreResult> {
  const listText = transmitters
    .map(
      (item) =>
        `ID:${item.transmitter.id},Nama:${item.transmitter.name},Jarak:${item.distanceKm.toFixed(1)}km,Arah:${item.bearing.toFixed(0)}°`
    )
    .join('\n')

  const prompt = `
Role: Expert DVB-T2 signal analyzer.
GPS: Lat ${userLocation.latitude}, Lon ${userLocation.longitude}.
List pemancar:
${listText}

Tugas:
1. Berikan skor (0-100) untuk masing-masing ID berdasarkan jarak (jarak lebih dekat mendapat skor lebih tinggi) dan azimuth.
2. Tentukan kelayakan ("Sangat Baik", "Baik", "Cukup", atau "Kurang").
3. Tentukan ID pemancar terbaik keseluruhan dan berikan penjelasan singkat (1 kalimat bahasa Indonesia).

Format output wajib JSON valid tanpa teks pengantar:
{
  "scores": [
    { "id": 900001, "score": 92, "recommendation": "Sangat Baik" }
  ],
  "bestTransmitterId": 900001,
  "bestTransmitterReason": "Pemancar TVRI Joglo adalah pilihan terbaik karena paling dekat dan minim halangan geografis."
}
`

  try {
    const responseText = await callGemini(prompt, true)
    return JSON.parse(responseText.trim()) as ScoreResult
  } catch (err) {
    console.warn('Gagal memuat rekomendasi AI Gemini:', err)
    return { scores: [], bestTransmitterId: null, bestTransmitterReason: '' }
  }
}

interface SearchQueryResult {
  matchingIds: number[]
  searchExplanation: string
}

export async function analyzeSearchQuery(
  query: string,
  userLocation: UserLocation,
  transmitters: RankedTransmitter[]
): Promise<SearchQueryResult> {
  if (!isGeminiConfigured()) {
    return generateLocalSearch(query, transmitters)
  }

  const listText = transmitters
    .map(
      (item) =>
        `ID:${item.transmitter.id},Nama:${item.transmitter.name},Jarak:${item.distanceKm.toFixed(1)}km,Arah:${item.bearing.toFixed(0)}°`
    )
    .join('\n')

  const prompt = `
Role: Search Assistant.
GPS: Lat ${userLocation.latitude}, Lon ${userLocation.longitude}.
Kueri: "${query}"
Pemancar:
${listText}

Tugas:
1. Saring ID pemancar terdekat yang paling relevan dengan kueri.
2. Berikan penjelasan singkat hasil penyaringan (1 kalimat Bahasa Indonesia).

Format output wajib JSON valid tanpa teks pengantar:
{
  "matchingIds": [900001, 900002],
  "searchExplanation": "Menampilkan pemancar TVRI terdekat untuk lokasi Anda."
}
`

  try {
    const responseText = await callGemini(prompt, true)
    return JSON.parse(responseText.trim()) as SearchQueryResult
  } catch (err) {
    console.warn('Gagal memproses pencarian AI Gemini, beralih ke kueri lokal:', err)
    return generateLocalSearch(query, transmitters)
  }
}

export async function compareTransmitters(
  userLocation: UserLocation,
  selectedTransmitters: RankedTransmitter[]
): Promise<string> {
  if (!isGeminiConfigured()) {
    return generateLocalComparison(selectedTransmitters)
  }

  const listText = selectedTransmitters
    .map(
      (item) =>
        `- ${item.transmitter.name}: Jarak ${item.distanceKm.toFixed(1)} km, Arah ${item.bearing.toFixed(0)}°`
    )
    .join('\n')

  const prompt = `
Role: TV transmitter analyst.
GPS: Lat ${userLocation.latitude}, Lon ${userLocation.longitude}.
Bandingkan pemancar berikut:
${listText}

Tulis analisis komparasi singkat & padat (Bahasa Indonesia, format Markdown):
1. Perbandingan jarak, azimuth, dan potensi kekuatan sinyal.
2. Rekomendasi tinggi tiang / tipe antena (indoor/outdoor) berdasarkan jarak.
3. Kesimpulan tegas pemancar terbaik untuk dipilih.
`

  try {
    return await callGemini(prompt, false)
  } catch (err) {
    console.warn('Gagal memproses perbandingan AI Gemini, beralih ke komparasi lokal:', err)
    return generateLocalComparison(selectedTransmitters)
  }
}

// === LOCAL FALLBACK UTILITIES ===

function generateLocalSearch(query: string, transmitters: RankedTransmitter[]): SearchQueryResult {
  const cleanQuery = query.toLowerCase()
  let matchingIds: number[] = []
  let explanation = ''

  // Common TV networks in Indonesia
  const networks = ['tvri', 'rcti', 'sctv', 'indosiar', 'metro', 'trans', 'antv', 'tvone', 'mnc', 'global']
  const matchedNetwork = networks.find((net) => cleanQuery.includes(net))

  if (matchedNetwork) {
    const matches = transmitters.filter((t) =>
      t.transmitter.name.toLowerCase().includes(matchedNetwork)
    )
    matchingIds = matches.map((m) => m.transmitter.id)
    explanation = `Menampilkan pemancar TV terkait jaringan "${matchedNetwork.toUpperCase()}" di sekitar area Anda (Kalkulasi Offline).`
  }

  // Check if query is looking for nearest
  if (
    matchingIds.length === 0 &&
    (cleanQuery.includes('dekat') || cleanQuery.includes('bagus') || cleanQuery.includes('stabil') || cleanQuery.includes('cepat'))
  ) {
    // Return top 4 closest
    const matches = transmitters.slice(0, 4)
    matchingIds = matches.map((m) => m.transmitter.id)
    explanation = 'Menampilkan 4 pemancar terdekat dengan proyeksi sinyal terbaik untuk daerah Anda (Kalkulasi Offline).'
  }

  // Default fallback
  if (matchingIds.length === 0) {
    const matches = transmitters.filter((t) =>
      t.transmitter.name.toLowerCase().includes(cleanQuery)
    )
    if (matches.length > 0) {
      matchingIds = matches.map((m) => m.transmitter.id)
      explanation = `Menampilkan hasil pemancar yang cocok dengan kata kunci "${query}" (Kalkulasi Offline).`
    } else {
      // Just return everything
      matchingIds = transmitters.map((t) => t.transmitter.id)
      explanation = `Kueri "${query}" tidak spesifik. Menampilkan seluruh pemancar terdekat (Kalkulasi Offline).`
    }
  }

  return { matchingIds, searchExplanation: explanation }
}

function generateLocalComparison(selectedTransmitters: RankedTransmitter[]): string {
  const lines: string[] = []
  lines.push('### 📊 Hasil Komparasi Pemancar (Kalkulasi Offline)')
  lines.push('Berikut adalah perbandingan fisik menara pemancar yang Anda pilih untuk mengarahkan antena:\n')

  // Sort by distance
  const sorted = [...selectedTransmitters].sort((a, b) => a.distanceKm - b.distanceKm)

  sorted.forEach((item, index) => {
    const name = item.transmitter.name
    const dist = item.distanceKm.toFixed(1)
    const angle = item.bearing.toFixed(0)
    const dir = getCompassDirection(item.bearing)

    let antennaRec = ''
    let signalStrength = ''

    if (item.distanceKm < 15) {
      antennaRec = 'Antena dalam ruangan (indoor) atau antena luar ruangan (outdoor) tipe kecil (e.g. Yagi pendek). Tidak memerlukan tiang tinggi.'
      signalStrength = 'Sangat Kuat'
    } else if (item.distanceKm < 30) {
      antennaRec = 'Antena luar ruangan (outdoor) tipe sedang. Pasang tiang setinggi 3-4 meter agar melewati atap tetangga.'
      signalStrength = 'Baik & Stabil'
    } else if (item.distanceKm < 45) {
      antennaRec = 'Wajib menggunakan Antena luar ruangan (outdoor) tipe Yagi panjang (high gain) dengan booster aktif. Ketinggian tiang minimal 6 meter.'
      signalStrength = 'Cukup / Rentan Halangan'
    } else {
      antennaRec = 'Wajib menggunakan Antena luar ruangan Yagi panjang maksimal + booster outdoor aktif. Tiang wajib tinggi (8-10 meter) melampaui pohon/gedung.'
      signalStrength = 'Lemah / Sangat Tergantung Tinggi Antena'
    }

    lines.push(`#### ${index + 1}. ${name}`)
    lines.push(`- **Jarak**: ${dist} km (${signalStrength})`)
    lines.push(`- **Arah Kompas**: ${angle}° (${dir})`)
    lines.push(`- **Rekomendasi Perangkat**: ${antennaRec}`)
    lines.push('')
  })

  // Compare best and worst
  const best = sorted[0]
  const worst = sorted[sorted.length - 1]
  const diffKm = (worst.distanceKm - best.distanceKm).toFixed(1)

  lines.push('### 📝 Kesimpulan Analisis')
  lines.push(`Pemancar **${best.transmitter.name}** adalah pilihan yang paling direkomendasikan karena lokasinya terdekat yaitu berjarak **${best.distanceKm.toFixed(1)} km** (selisih **${diffKm} km** lebih dekat dibandingkan pemancar ${worst.transmitter.name}).`)
  lines.push(`Disarankan untuk mengarahkan antena TV Anda lurus ke sudut **${best.bearing.toFixed(0)}° (${getCompassDirection(best.bearing)})** untuk memperoleh penguncian sinyal digital terbaik.`)

  return lines.join('\n')
}

export async function searchTransmittersWithAI(userLocation: UserLocation): Promise<Transmitter[]> {
  const prompt = `
Role: Database GIS Pemancar TV Digital DVB-T2 Indonesia.
GPS: Lat ${userLocation.latitude}, Lon ${userLocation.longitude}.

Tugas:
1. Cari 15 hingga maksimal 20 stasiun pemancar TV digital DVB-T2 terdekat (radius < 60 km).
2. Fokus pencarian wajib eksklusif hanya pada menara pemancar fisik berjenis:
   - Menara Pemancar TV Digital
   - Stasiun Transmisi TV Digital
   (Menara infrastruktur transmisi penyiaran televisi UHF DVB-T2).
3. Data yang dihasilkan harus mencakup pemancar TV digital untuk semua stasiun TV secara merata (wajib mencakup TVRI, RCTI, SCTV, Indosiar, Metro TV, Trans TV, Trans7, tvOne, ANTV, Kompas TV, NET TV, RTV, iNews, BTV, dll. agar semua jaringan TV terwakili).
4. DILARANG KERAS memasukkan Menara Kominfo, kantor Kominfo, menara seluler/tiang provider GSM (e.g. Telkomsel, XL, Indosat, tower provider umum), menara Telkom, atau menara pemancar radio non-TV.
5. Tentukan koordinat Latitude dan Longitude yang sangat akurat berdasarkan lokasi nyata menara tersebut di Indonesia.
6. Berikan ID acak unik (900500-900999) dan relevansi (0-100) berdasarkan kedekatan jarak.

Format output wajib JSON array valid tanpa penjelasan teks pengantar:
[
  {
    "id": 900501,
    "name": "Stasiun Pemancar TVRI Joglo",
    "latitude": -6.2223,
    "longitude": 106.7324,
    "relevanceScore": 95,
    "sourceType": "node"
  }
]
`

  if (!isGeminiConfigured()) {
    return []
  }
  try {
    const responseText = await callGemini(prompt, true)
    return JSON.parse(responseText.trim()) as Transmitter[]
  } catch (err) {
    console.warn('Gagal mencari pemancar dengan AI Gemini, beralih ke pencarian offline:', err)
    return []
  }
}

