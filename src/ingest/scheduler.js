import { ingestDFPLandingsites, ingestDFPRail } from './droneflightplanner.js'

// kick off after startup
setTimeout(() => { ingestDFPLandingsites().catch(console.error) }, 4000)
setTimeout(() => { ingestDFPRail().catch(console.error) }, 6000)

// refresh hourly
setInterval(() => ingestDFPLandingsites().catch(console.error), 3600_000)
setInterval(() => ingestDFPRail().catch(console.error), 3600_000)
