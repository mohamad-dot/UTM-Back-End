import express from 'express'
import dotenv from 'dotenv'
import fetch from 'node-fetch'
import cors from 'cors'
import { pool } from './db.js'
import { decideFlight } from './decision.js'
import './ingest/scheduler.js'

dotenv.config()
const app = express()
app.use(cors())
app.use(express.json({ limit:'2mb' }))


app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'UTM backend', version: '0.1.0' })
})

function bboxToWKT(bbox){
  const [w,s,e,n] = bbox.map(Number)
  return `POLYGON((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}))`
}


function parseWKT(wkt) {
  if (!wkt) return null
  const t = String(wkt).trim()
  const T = t.toUpperCase()
  if (T.startsWith('POINT(')) {
    const body = t.slice(6, -1).trim()
    const [latStr, lonStr] = body.split(/\s+/)
    const lat = Number(latStr), lon = Number(lonStr)
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { type: 'Point', coordinates: [lon, lat] } // flip to lon,lat
    }
    return null
  }
  if (T.startsWith('LINESTRING(')) {
    const body = t.slice(11, -1)
    const pairs = body.split(',').map(s => s.trim().split(/\s+/).map(Number))
    const coords = pairs.map(([lat, lon]) => [lon, lat])
    return { type: 'LineString', coordinates: coords }
  }
  if (T.startsWith('POLYGON((')) {
    const body = t.slice(9, -2)
    const rings = body.split('),(').map(r =>
      r.split(',').map(p => {
        const [lat, lon] = p.trim().split(/\s+/).map(Number)
        return [lon, lat]
      })
    )
    return { type: 'Polygon', coordinates: rings }
  }
  return null
}



// Generic helper for calling upstream JSON APIs
async function fetchJsonOrThrow(url, options = {}) {
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: { Accept: 'application/json', ...(options.headers || {}) },
    body: options.body,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Upstream ${url} failed: ${res.status} ${res.statusText} — ${text}`)
  }
  try { return JSON.parse(text) } catch {
    return text
  }
}


app.get('/v1/zones', async (req,res) => {
  try {
    const bbox = String(req.query.bbox||'').split(',').map(Number)
    const t = String(req.query.time||new Date().toISOString().slice(0,19).replace('T',' '))
    const wkt = bboxToWKT(bbox)
    const conn = await pool.getConnection()
    try {
      await conn.query('SET @bbox = ST_SRID(ST_PolygonFromText(:wkt), 4326)', { wkt })
      const [rows] = await conn.query(
        `SELECT id, UTME3ZON_Name AS name, ST_AsGeoJSON(zone_geom) AS gj
         FROM UTMEurope3_Zones
         WHERE ST_Intersects(zone_geom, @bbox)
           AND (UTME3ZON_valid_from IS NULL OR UTME3ZON_valid_from <= :t)
           AND (UTME3ZON_valid_to   IS NULL OR UTME3ZON_valid_to   >= :t)`, { t })
      const features = rows.map(r => ({ type:'Feature', properties:{ id:r.id, name:r.name }, geometry: JSON.parse(r.gj) }))
      res.json({ type:'FeatureCollection', features })
    } finally { conn.release() }
  } catch (e){ console.error(e); res.status(500).json({ error:String(e) }) }
})

app.get('/v1/notams', async (req,res) => {
  try {
    const bbox = String(req.query.bbox||'').split(',').map(Number)
    const t = String(req.query.time||new Date().toISOString().slice(0,19).replace('T',' '))
    const wkt = bboxToWKT(bbox)
    const conn = await pool.getConnection()
    try {
      await conn.query('SET @bbox = ST_SRID(ST_PolygonFromText(:wkt), 4326)', { wkt })
      const [rows] = await conn.query(
        `SELECT id, UTME3NTM_Title AS title, UTME3NTM_Severity AS severity, ST_AsGeoJSON(notam_geom) AS gj
         FROM UTMEurope3_Notams
         WHERE ST_Intersects(notam_geom, @bbox)
           AND UTME3NTM_Start <= :t
           AND (UTME3NTM_End IS NULL OR UTME3NTM_End >= :t)`, { t })
      const features = rows.map(r => ({ type:'Feature', properties:{ id:r.id, title:r.title, severity:r.severity }, geometry: JSON.parse(r.gj) }))
      res.json({ type:'FeatureCollection', features })
    } finally { conn.release() }
  } catch (e){ console.error(e); res.status(500).json({ error:String(e) }) }
})

app.get('/v1/weather', async (req,res) => {
  try {
    const bbox = String(req.query.bbox||'').split(',').map(Number)
    const t = String(req.query.time||new Date().toISOString().slice(0,19).replace('T',' '))
    const wkt = bboxToWKT(bbox)
    const conn = await pool.getConnection()
    try {
      await conn.query('SET @bbox = ST_SRID(ST_PolygonFromText(:wkt), 4326)', { wkt })
      const [rows] = await conn.query(
        `SELECT UTME3WTH_lat AS lat, UTME3WTH_lon AS lng,
                UTME3WTH_temperature AS tempC, UTME3WTH_wind_speed AS windKts,
                UTME3WTH_wind_direction AS windDir, UTME3WTH_condition AS phenomena
         FROM UTMEurope3_Weather
         WHERE weather_point IS NOT NULL
           AND ST_Intersects(weather_point, @bbox)
           AND UTME3WTH_observed_at <= :t
           AND (UTME3WTH_valid_to IS NULL OR UTME3WTH_valid_to >= :t)`, { t })
      res.json({ updated: new Date().toISOString(), observations: rows })
    } finally { conn.release() }
  } catch (e){ console.error(e); res.status(500).json({ error:String(e) }) }
})



// --- Drone Flight Planner (DFP) spoor (rail) ---
app.get('/v1/dfp/spoor', async (req, res) => {
  try {
    const baseUrl = process.env.DFP_SPOOR_URL
    if (!baseUrl) return res.status(500).json({ error: 'DFP_SPOOR_URL not configured' })

    const urlObj = new URL(baseUrl)
    for (const [k, v] of Object.entries(req.query)) {
      urlObj.searchParams.set(k, String(v))
    }

    const raw = await fetchJsonOrThrow(urlObj.toString())
    const rows = Array.isArray(raw) ? raw : []

    const features = []
    for (const row of rows) {
      const geom = parseWKT(row.Coordinates || row.coordinates || row.geom || row.geometry)
      if (!geom) continue
      features.push({
        type: 'Feature',
        properties: {
          id: row.ID || row.id || row.Name || row.Sourcetext || undefined,
          name: row.Sourcetext || row.Name || 'Railway',
        },
        geometry: geom,
      })
    }

    res.json({ type: 'FeatureCollection', features })
  } catch (e) {
    console.error(e)
    res.status(502).json({ error: String(e) })
  }
})
// --- Drone Flight Planner (DFP) landingsites ---
app.get('/v1/dfp/landingsites', async (req, res) => {
  try {
    const baseUrl = process.env.DFP_LANDINGSITE_URL
    if (!baseUrl) return res.status(500).json({ error: 'DFP_LANDINGSITE_URL not configured' })

    const urlObj = new URL(baseUrl)
    for (const [k, v] of Object.entries(req.query)) {
      urlObj.searchParams.set(k, String(v))
    }

    const raw = await fetchJsonOrThrow(urlObj.toString())
    const rows = Array.isArray(raw) ? raw : []

    const features = []
    for (const row of rows) {
      const geom = parseWKT(row.Coordinates || row.coordinates || row.geom || row.geometry)
      if (!geom) continue
      features.push({
        type: 'Feature',
        properties: {
          id: row.ID || row.id || row.Name || row.Sourcetext || undefined,
          name: row.Sourcetext || row.Name || 'Landing site',
        },
        geometry: geom,
      })
    }

    res.json({ type: 'FeatureCollection', features })
  } catch (e) {
    console.error(e)
    res.status(502).json({ error: String(e) })
  }
})
// --- External zones / NOTAM API (new UTM system) ---
app.get('/v1/zones-external', async (req, res) => {
  try {
    const baseUrl = process.env.ZONES_API_URL
    if (!baseUrl) return res.status(500).json({ error: 'ZONES_API_URL not configured' })

    const urlObj = new URL(baseUrl)
    for (const [k, v] of Object.entries(req.query)) {
      urlObj.searchParams.set(k, String(v))
    }

    const data = await fetchJsonOrThrow(urlObj.toString())
    res.json(data)
  } catch (e) {
    console.error(e)
    res.status(502).json({ error: String(e) })
  }
})

// --- External weather (live) ---
app.get('/v1/weather-external', async (req, res) => {
  try {
    const base = process.env.EXTERNAL_WEATHER_BASE
    if (!base) return res.status(500).json({ error: 'EXTERNAL_WEATHER_BASE not configured' })

    const bboxStr = String(req.query.bbox || '')
    const parts = bboxStr.split(',').map(Number)
    if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
      return res.status(400).json({ error: 'Invalid bbox; expected "w,s,e,n"' })
    }
    const [w, s, e, n] = parts
    const lat = (s + n) / 2
    const lon = (w + e) / 2
    const radiusKm = Number(req.query.radiusKm || 4)

    const url = `${base}/${lat.toFixed(5)}/${lon.toFixed(5)}/${radiusKm}`
    const data = await fetchJsonOrThrow(url)
    res.json(data)
  } catch (e) {
    console.error(e)
    res.status(502).json({ error: String(e) })
  }
})

// --- ADS-B traffic (non-drone flights) ---
app.get('/v1/traffic', async (req, res) => {
  try {
    const baseUrl = process.env.ADSB_URL
    if (!baseUrl) return res.status(500).json({ error: 'ADSB_URL not configured' })

    const urlObj = new URL(baseUrl)
    for (const [k, v] of Object.entries(req.query)) {
      urlObj.searchParams.set(k, String(v))
    }

    const data = await fetchJsonOrThrow(urlObj.toString())
    res.json(data)
  } catch (e) {
    console.error(e)
    res.status(502).json({ error: String(e) })
  }
})

// --- Remote ID: drone history ---
app.get('/v1/drone-history/:droneId', async (req, res) => {
  try {
    const baseUrl = process.env.REMOTEID_BASE_URL
    if (!baseUrl) return res.status(500).json({ error: 'REMOTEID_BASE_URL not configured' })

    const id = encodeURIComponent(req.params.droneId)
    const url = `${baseUrl.replace(/\/+$/, '')}/${id}`

    const data = await fetchJsonOrThrow(url)
    res.json(data)
  } catch (e) {
    console.error(e)
    res.status(502).json({ error: String(e) })
  }
})

// --- GDPR API secure proxy ---
const gdprRouter = express.Router()

gdprRouter.use(async (req, res) => {
  try {
    const base = process.env.GDPR_API_BASE
    const appName = process.env.GDPR_APP_NAME
    const appKey = process.env.GDPR_APP_KEY

    if (!base || !appName || !appKey) {
      return res.status(500).json({ error: 'GDPR_API_BASE / GDPR_APP_NAME / GDPR_APP_KEY not configured' })
    }

    const targetUrl = base.replace(/\/+$/, '') + req.url

    const headers = {
      'Applicationname': appName,
      'Key': appKey,
      'Accept': req.get('accept') || 'application/json',
    }

    let body
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(req.body ?? {})
    }

    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
    })

    const text = await upstream.text()
    res.status(upstream.status)

    const ct = upstream.headers.get('content-type') || ''
    if (ct.includes('application/json')) {
      try {
        return res.json(JSON.parse(text))
      } catch {
        // fall through
      }
    }
    return res.send(text)
  } catch (e) {
    console.error(e)
    res.status(502).json({ error: String(e) })
  }
})

app.use('/v1/gdpr', gdprRouter)


app.post('/v1/flight-requests', async (req,res) => {
  try {
    const result = await decideFlight(req.body || {})
    res.json(result)
  } catch (e){ console.error(e); res.status(400).json({ error:String(e) }) }
})

const PORT = process.env.PORT || 8787
app.listen(PORT, () => console.log(`UTM backend listening on http://localhost:${PORT}`))
