import fetch from 'node-fetch'
import * as turf from '@turf/turf'
import { pool } from '../db.js'

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

async function insertZone({ name, gj, valid_from=null, valid_to=null, floor_m=null, ceiling_m=null }) {
  const conn = await pool.getConnection()
  try {
    await conn.query(
      `INSERT INTO UTMEurope3_Zones
       (UTME3ZON_Name, UTME3ZON_GeoJSON, UTME3ZON_valid_from, UTME3ZON_valid_to, UTME3ZON_floor_m, UTME3ZON_ceiling_m)
       VALUES (:name, CAST(:gj AS JSON), :vf, :vt, :floor, :ceil)`,
      { name, gj: JSON.stringify(gj), vf: valid_from, vt: valid_to, floor: floor_m, ceil: ceiling_m }
    )
  } finally { conn.release() }
}

export async function ingestDFPLandingsites() {
  const url = process.env.DFP_LANDINGSITE_URL
  if (!url) { console.warn('[ingest] DFP_LANDINGSITE_URL not set'); return 0 }
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch (e) {
    console.error('[ingest] landingsite: JSON parse error')
    return 0
  }
  const radius = Number(process.env.DFP_LANDINGSITE_RADIUS || 300)
  let count = 0
  for (const row of data) {
    const geom = parseWKT(row.Coordinates)
    if (!geom) continue
    const pt = turf.point(geom.coordinates)
    const poly = turf.buffer(pt, radius, { units: 'meters' })
    await insertZone({ name: row.Sourcetext || row.Name || 'Landing site', gj: poly.geometry })
    count++
  }
  console.log(`[ingest] DFP landingsites inserted: ${count}`)
  return count
}

export async function ingestDFPRail() {
  const url = process.env.DFP_SPOOR_URL
  if (!url) { console.warn('[ingest] DFP_SPOOR_URL not set'); return 0 }
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch (e) {
    console.error('[ingest] spoor: JSON parse error')
    return 0
  }
  const buf = Number(process.env.DFP_SPOOR_BUFFER || 100)
  let count = 0
  for (const row of data) {
    const geom = parseWKT(row.Coordinates)
    if (!geom) continue
    let poly = null
    if (geom.type === 'LineString') {
      poly = turf.buffer(turf.lineString(geom.coordinates), buf, { units: 'meters' })
    } else if (geom.type === 'Point') {
      poly = turf.buffer(turf.point(geom.coordinates), buf, { units: 'meters' })
    } else if (geom.type === 'Polygon') {
      poly = turf.polygon(geom.coordinates)
    }
    if (!poly) continue
    await insertZone({ name: row.Sourcetext || row.Name || 'Railway', gj: poly.geometry })
    count++
  }
  console.log(`[ingest] DFP spoor zones inserted: ${count}`)
  return count
}
