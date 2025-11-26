# UTM Backend Starter (with DroneFlightPlanner ingesters)

## Setup
1. Extract this folder.
2. Create `.env` from `.env.example` and fill DB credentials (MySQL with UTMEurope3 schema).
3. Install and migrate:
   ```
   npm install
   npm run migrate
   npm run dev
   ```

The server runs on `http://localhost:8787` and automatically ingests:
- Landing sites → buffered polygons
- Railways (spoor) → buffered corridors

## Endpoints
- `GET /v1/zones?bbox=w,s,e,n&time=YYYY-MM-DD hh:mm:ss`
- `GET /v1/notams?...` (placeholder; )
- `GET /v1/weather?...` (placeholder)
- `POST /v1/flight-requests` → approve / rejected / alternative

## Frontend
 React app `.env` :
```
VITE_MOCK_DATA=false
VITE_API_BASE=http://localhost:8787
VITE_POLL_MS=5000
```

## Notes
- Geometry columns are generated and indexed by the migration script.
- DroneFlightPlanner APIs sometimes respond with JSON but text/html content-type; the ingester handles this.
- Buffers are configurable via `.env`.
