import { pool } from './db.js'
import * as turf from '@turf/turf'
import { makeCorridor, lineBbox, bboxToPolygonWKT, simplifyLine } from './geo.js'

export async function decideFlight({ operatorId, droneId, purpose, timeStart, timeEnd, route }){
  if (!route || route.type !== 'LineString' || !Array.isArray(route.coordinates)) {
    throw new Error('Invalid route LineString')
  }
  const corridor = makeCorridor(route, 50)
  const bbox = lineBbox(route)
  const conn = await pool.getConnection()
  try {
    const wkt = bboxToPolygonWKT(bbox)

    await conn.query('SET @bbox = ST_SRID(ST_PolygonFromText(:wkt), 4326)', { wkt })

    const [zones] = await conn.query(
      `SELECT id, UTME3ZON_Name AS name, ST_AsGeoJSON(zone_geom) AS gj
       FROM UTMEurope3_Zones
       WHERE ST_Intersects(zone_geom, @bbox)
         AND (UTME3ZON_valid_from IS NULL OR UTME3ZON_valid_from <= :end)
         AND (UTME3ZON_valid_to   IS NULL OR UTME3ZON_valid_to   >= :start)`,
      { start: timeStart, end: timeEnd }
    )

    const [notams] = await conn.query(
      `SELECT id, UTME3NTM_Title AS title, UTME3NTM_Severity AS severity, ST_AsGeoJSON(notam_geom) AS gj
       FROM UTMEurope3_Notams
       WHERE ST_Intersects(notam_geom, @bbox)
         AND UTME3NTM_Start <= :end
         AND (UTME3NTM_End IS NULL OR UTME3NTM_End >= :start)`,
      { start: timeStart, end: timeEnd }
    )

    const hardReasons = []
    const softReasons = []
    const corridorFeat = corridor

    const intersects = (gj) => {
      if (!gj) return false
      const f = JSON.parse(gj)
      try { return turf.booleanIntersects(f, corridorFeat) }
      catch { return false }
    }

    for (const z of zones){
      if (intersects(z.gj)) hardReasons.push({ code:'AIRSPACE_RESTRICTED', detail:z.name })
    }
    for (const n of notams){
      if (intersects(n.gj)) {
        const bucket = (n.severity||'hard') === 'hard' ? hardReasons : softReasons
        bucket.push({ code:`NOTAM_${(n.severity||'hard').toUpperCase()}`, detail:n.title })
      }
    }

    const [wx] = await conn.query(
      `SELECT UTME3WTH_wind_speed AS windKts
       FROM UTMEurope3_Weather
       WHERE weather_point IS NOT NULL
         AND ST_Intersects(weather_point, @bbox)
         AND UTME3WTH_observed_at <= :end
         AND (UTME3WTH_valid_to IS NULL OR UTME3WTH_valid_to >= :start)`,
      { start: timeStart, end: timeEnd }
    )
    const windLimit = 25
    if (Array.isArray(wx)) {
      for (const w of wx){
        if (Number(w.windKts) > windLimit){
          softReasons.push({ code:'WEATHER_WIND', detail:`Wind ${w.windKts}kt > ${windLimit}` })
          break
        }
      }
    }

    if (hardReasons.length){
      return { decision:'rejected', reasons: hardReasons }
    }
    if (!softReasons.length){
      return { decision:'approved', reasons: [] }
    }

    const alt = computeAlternative(route, bbox, zones)
    if (alt){
      return { decision:'alternative', reasons: softReasons, alternativeRoute: alt }
    }
    return { decision:'rejected', reasons: softReasons }
  } finally {
    conn.release()
  }
}

function computeAlternative(route, bbox, zones){
  const obstacles = (zones||[]).map(z => JSON.parse(z.gj))

  const start = route.coordinates[0]
  const end   = route.coordinates[route.coordinates.length-1]

  const [w,s,e,n] = bbox
  const steps = 40
  const dx = (e-w)/steps
  const dy = (n-s)/steps
  const nodes = []
  const index = (ix,iy)=> iy*(steps+1)+ix
  const blocked = new Set()

  for (let iy=0; iy<=steps; iy++){
    for (let ix=0; ix<=steps; ix++){
      const p = [w+ix*dx, s+iy*dy]
      nodes.push(p)
      const pt = turf.point(p)
      for (const o of obstacles){
        if (turf.booleanPointInPolygon(pt, o)) { blocked.add(index(ix,iy)); break }
      }
    }
  }

  function nearestNodeIndex([lon,lat]){
    let best=-1, bestD=1e9
    for (let i=0;i<nodes.length;i++){
      const p = nodes[i]; const d=(p[0]-lon)*(p[0]-lon)+(p[1]-lat)*(p[1]-lat)
      if (d<bestD){ bestD=d; best=i }
    }
    return best
  }

  let sIdx = nearestNodeIndex(start)
  let eIdx = nearestNodeIndex(end)
  if (blocked.has(sIdx) || blocked.has(eIdx)) {
    const adjust = (idx)=>{
      const ix = idx % (steps+1), iy = Math.floor(idx/(steps+1))
      const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]
      for (const [dxi,dyi] of dirs){
        const jx=ix+dxi, jy=iy+dyi
        if (jx>=0 && jx<=steps && jy>=0 && jy<=steps){
          const j=index(jx,jy)
          if (!blocked.has(j)) return j
        }
      }
      return idx
    }
    if (blocked.has(sIdx)) sIdx = adjust(sIdx)
    if (blocked.has(eIdx)) eIdx = adjust(eIdx)
  }

  const open = new Set([sIdx])
  const cameFrom = new Map()
  const gScore = new Map([[sIdx,0]])
  const h = (i)=>{
    const a=nodes[i], b=nodes[eIdx]
    return Math.hypot(a[0]-b[0], a[1]-b[1])
  }
  const fScore = new Map([[sIdx,h(sIdx)]])

  const neighbors = (i)=>{
    const res=[]
    const ix = i % (steps+1)
    const iy = Math.floor(i/(steps+1))
    for (const [dxi,dyi] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]){
      const jx=ix+dxi, jy=iy+dyi
      if (jx<0||jx>steps||jy<0||jy>steps) continue
      const j=index(jx,jy)
      if (blocked.has(j)) continue
      res.push(j)
    }
    return res
  }

  while (open.size){
    let current=null, best=1e12
    for (const i of open){
      const fs = fScore.get(i) ?? 1e12
      if (fs<best){ best=fs; current=i }
    }
    if (current===eIdx){
      const path=[current]
      while (cameFrom.has(current)){
        current = cameFrom.get(current)
        path.push(current)
      }
      path.reverse()
      const coords = path.map(i => nodes[i])
      const line = turf.lineString(coords)
      const simple = simplifyLine(line, 30)
      return simple
    }
    open.delete(current)
    for (const nb of neighbors(current)){
      const tentative = (gScore.get(current) ?? 1e12) + 1
      if (tentative < (gScore.get(nb) ?? 1e12)){
        cameFrom.set(nb, current)
        gScore.set(nb, tentative)
        fScore.set(nb, tentative + h(nb))
        open.add(nb)
      }
    }
  }
  return null
}
