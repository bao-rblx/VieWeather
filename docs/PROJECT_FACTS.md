# VieWeather — verified project facts (source of truth for the report and the deck)

Every number below was measured in this workspace. Anything not measured is marked NOT MEASURED.

## Identity
- Course: 72ITDS40303 Big Data Analytics, Semester 261, Van Lang University
- Project: VieWeather — a Vietnam weather streaming lakehouse with a live map client
- Team (4 members):
  1. Luu Gia Bao — 2474802010028
  2. Nguyen Trung Duc — (student ID to be filled)
  3. Tran Quang Minh — (student ID to be filled)
  4. Nguyen Gia Thanh — (student ID to be filled)

## Question the system answers
How does a stateful weather stream behave as volume, arrival rate, duplicate rate and lateness increase,
and can one replayable lake serve both a live map and weekly regional reporting?

## Stack and versions (measured)
- Node.js v24.16.0; React 19.1.0; react-dom 19.1.0; MapLibre GL JS 6.16.0; lucide-react 0.468
- Python 3.12.14 (runtime used this session) / Python 3.11.9 (system interpreter)
- FastAPI 0.115.6, uvicorn, httpx
- Spark 3.5.3, Java 17.0.21, OS Linux 6.18.33.2-microsoft-standard-WSL2 (from data/lake run log, 2026-11-01)
- Docker Compose profile "streaming" brings up the Spark stack

## Code size (measured)
- 31 source files, 14,425 lines total
  - src/ (React client): 16 files, 10,500 lines
  - backend/ (FastAPI + pipeline adapters): 6 files, 2,028 lines
  - scripts/ (generators, reports, launcher): 6 files, 735 lines
  - tests/ (pytest): 3 files, 1,162 lines
- pytest: 77 passed (last run this session)
- TypeScript: 0 errors (npx tsc --noEmit)
- Production bundle: 3 JS/CSS assets, ~2.4 MB on disk; maplibre chunk 1,078 kB (gzip 296 kB),
  app chunk 351 kB (gzip 109 kB), CSS 130 kB (gzip 23 kB)

## HTTP surface (12 endpoints, all implemented)
/api/health, /api/weather, /api/history/{city_id}, /api/analytics, /api/export, /api/events (SSE),
/api/air-quality/{city_id}, /api/cities/search, /api/alerts, /api/field, /api/places, /api/models

## Provenance
- Weather + air quality: Open-Meteo (CC BY 4.0, attribution required). Models: ecmwf_ifs025 (default),
  best_match, icon_seamless, gfs_seamless.
- Boundaries/roads/labels basemap: OpenFreeMap / OpenMapTiles (OpenStreetMap ODbL).
- Satellite + relief raster: Esri World Imagery / World Physical Map (attribution required).
- Terrain: Terrarium DEM tiles (S3 elevation-tiles-prod).
- Gazetteer: GeoNames VN dump, CC BY 4.0 — 67,146 raw records reduced to 5,187 places.
- Coverage: 27 monitored locations — 25 mainland cities plus the Hoang Sa (Paracel) and Truong Sa (Spratly) island groups, which give the field and the report a real maritime extent. Region labels are analytical groupings, not official administrative boundaries.

## Data contract (measured real payload)
- Newline-delimited JSON events, written as .tmp then atomically renamed to .json
- event_id = SHA-256 of (city_id | observedAt | source), 64 lowercase hex chars
- Sources kept distinct everywhere: open-meteo, demo, load-test
- Ranges: temperature -30..60 C, humidity 0..100 %, wind 0..400 km/h, precipitation 0..1000 mm
- All stored timestamps UTC (ISO Z); browser renders Asia/Ho_Chi_Minh (UTC+7)

## Spark pipeline measurements (recorded run, 2026-11-01 16:07 +07, data/lake-report.log)
- Input: 23 JSON files, 32,714,428 bytes (31.2 MiB)
- Bronze: load-test 92,061 + demo 25 + open-meteo 50 = 92,136 unique event IDs; 7,844,619 bytes Parquet (7.48 MiB)
- Quarantine: 1,027 load-test rows rejected, 100,788 bytes
- Silver: 92 Parquet files, 331,723 bytes
- Gold: 23 batch snapshots, latest batchId 43 with 50 windows
- Configuration: Spark local[2], driver 2 GB, shuffle partitions 4, trigger 10 s, watermark 20 min,
  window 10 min sliding 5 min
- Environment: WSL2, Java 17.0.21, block manager 434.4 MiB RAM

## Producer measurement (re-run this session, scripts/generate_load.py)
- 100,000 events, batch 5,000, interval 0.05 s
- 20 atomic JSON files, 32,691,627 bytes (31.2 MiB)
- Generator write time 1.735 s -> 57,637 events/s; wall 1.86 s -> 53,879 events/s
- Injected faults by design: 5,108 duplicate rows, 970 invalid new events, 1,881 late events
- A deliberately paced run at interval 0.2 s measured 20,713 rows/s (recorded earlier); the difference
  is sleep between micro-batches, not processing speed.

## Serving layer measurements
- SQLite serving store: 2,425 observation rows from the recorded run (2,400 open-meteo + 25 demo); the live store now holds 27 forecast rows including both island groups, 25 forecast rows
- Dense field: 24 x 17 = 408 points per model, lon 102.0-114.5 E, so the archipelagos sit inside the sampled grid, refreshed on the 10-minute collector cadence
- Gazetteer: 5,187 places (7 major cities, 46 province capitals, 634 district towns, 4,500 commune seats),
  623 kB raw / 121 kB gzip, 34 provinces
- Provider quota budget: 600 units/minute and 5,000/hour modelled in backend/budget.py; one grid refresh
  reserves 340 units; cold start reserves ~517 of 600 units.

## Correctness evidence
- Streaming quality: 1,027 invalid rows quarantined rather than dropped
- Deduplication: 5,108 duplicate rows injected, event_id derived from (city, observation time, source)
  so repeat polls collapse; bronze unique IDs 92,136 against 92,136 accepted records
- Restart: pipeline restarts from persisted checkpoints; committed input is not replayed (documented in
  docs/VERIFICATION.md)
- Honest labelling: a synthesized grid is labelled source="synthetic" and is never drawn as weather;
  the client falls back to a field built from real cached observations.

## UI verification (this session, headless Edge + SwiftShader, 1440x900)
- Zero console errors across: 4 basemap modes, 4 dock tabs, 5 drawers, command palette, search,
  unit toggle, favourites, playback, alert dismissal, collapse/expand
- Wind particle animation proven by pixel diff: 26,958 pixels changed (2.96 %) between frames 420 ms apart
- Responsive at 430 / 900 / 1440 / 1600 px with no overflow
- prefers-reduced-motion: ambient layer becomes a static gradient, 0 ripples, transitions snap

## NOT MEASURED (must not be invented)
- Cluster/multi-node throughput
- Automated accessibility audit score
- Cold-start time of a fresh machine install
- Any per-window Spark state size beyond what the run log shows
