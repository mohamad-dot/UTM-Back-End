import * as turf from '@turf/turf'

export function makeCorridor(routeGeoJSON, widthMeters=50){
  const feat = routeGeoJSON.type === 'Feature' ? routeGeoJSON : { type:'Feature', geometry: routeGeoJSON, properties:{} }
  const coords2d = feat.geometry.coordinates.map(c => [c[0], c[1]])
  const line = turf.lineString(coords2d)
  const buff = turf.buffer(line, widthMeters, { units: 'meters' })
  return buff
}

export function bboxToPolygonWKT([w,s,e,n]){
  return `POLYGON((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}))`
}

export function lineBbox(line){
  const feat = line.type === 'Feature' ? line : { type:'Feature', geometry: line, properties:{} }
  return turf.bbox(feat)
}

export function simplifyLine(line, toleranceMeters=10){
  const feat = line.type === 'Feature' ? line : { type:'Feature', geometry: line, properties:{} }
  const simp = turf.simplify(feat, { tolerance: toleranceMeters/111000, highQuality: false, mutate:false })
  return simp.geometry
}
