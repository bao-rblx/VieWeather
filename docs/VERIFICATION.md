# Verification results

Verified on **1 November 2026 (Asia/Ho_Chi_Minh)** using Windows for the app and WSL Ubuntu for Spark.

## Automated checks

- `npm run build`: TypeScript compilation and Vite production build passed. MapLibre is bundled separately with its worker; the map bundle still produces Vite's large-chunk advisory (approximately 296 KB gzipped).
- `python -m pytest tests -q`: **7 passed**. Covers demo chronology, live-provider normalization, event deduplication, atomic file publication, persistence, stale cache, API/history/export responses, bad Spark output, and heartbeat expiry. The installed test stack emits an upstream AnyIO deprecation warning.
- `python -m ruff check backend pipeline scripts tests`: passed.
- `npm audit`: zero known vulnerabilities after updating MapLibre.
- Real Open-Meteo collection: all **27 cities** returned live current conditions and forecasts.

## Real Spark integration test

Runtime: Apache Spark **3.5.3**, Java **17.0.21**, Python **3.11.18**, Linux/WSL, `local[2]`.

`scripts/spark_smoke.py` starts the actual streaming program in an isolated directory, supplies fixtures, stops/restarts it with the same checkpoints, and reads the resulting Parquet lake:

| Check | Result |
| --- | --- |
| Duplicate in first input batch | Removed |
| Out-of-range temperature | Quarantined |
| Null humidity | Quarantined |
| Malformed JSON | Quarantined |
| First window average | 26 °C from two distinct events |
| Duplicate after restart | Removed using recovered state |
| New observation after restart | Processed |
| Final unique bronze events | 3 |
| Final quarantine rows | 3 |
| Final window aggregates | Two overlapping windows, each 3 events and 28 °C average |

The test was rerun after adding Spark heartbeat/metrics publishing. The production-like stream also fed live results into `/api/analytics`, and the browser displayed query state metrics.

## 100,000-row workload

Command:

```text
python scripts/generate_load.py --events 100000 --batch-size 5000 --interval 0.2
```

Generator report: 100,000 rows, 5,108 duplicate rows, 970 new invalid events, 1,881 new late events. Generation took **4.828 seconds**, or **20,713 producer rows/second**. This is producer throughput, not measured Spark throughput.

Actual lake results from `scripts/lake_report.py` after processing:

| Measurement | Result |
| --- | ---: |
| Valid unique `load-test` events in bronze | 92,061 |
| `load-test` rows in quarantine | 1,027 |
| Other bronze rows at measurement time | 25 demo + 50 provider |
| Total bronze rows / distinct event IDs | 92,136 / 92,136 |
| JSON input bytes, including provider/demo files | 32,714,428 |
| Bronze Parquet bytes | 7,844,619 |
| Quarantine Parquet bytes | 100,788 |
| Input files at measurement time | 23 |

The difference between generated rows and stored bronze rows reflects invalid records, duplicate removal, and watermark-based handling of late observations. Quarantine counts include repeated invalid rows; the generator's invalid count counts only newly created invalid events. A single run is a correctness/scale smoke check, not a comprehensive performance benchmark. See the course guide for repeatable comparative experiments.

## Browser checks

Checked the built app in the Codex browser at desktop (1440×1000) and mobile (390×844) dimensions:

- Base map and city columns render with the bundled MapLibre worker.
- Hanoi/Da Nang/Da Lat selection updates weather details.
- Celsius/Fahrenheit, rainfall layer, 2D/3D toggle, and keyboard timeline controls respond.
- Search isolates Da Lat; Highlands filtering returns its three monitored cities.
- Saving Da Lat survives a page reload.
- Forecast playback advances the timeline; pause stops it.
- Terrain toggles on/off without new browser errors during the check.
- Analytics shows real Spark window output; Data pipeline shows heartbeat status and measured state memory.
- Mobile layout has no horizontal document overflow.

Geolocation's real permission flow was not exercised. Docker is not installed on the host, so the Compose configuration was supplied but not executed; equivalent Spark processing was run and verified directly in WSL. No multi-node cluster, million-event benchmark, or production deployment is claimed.
