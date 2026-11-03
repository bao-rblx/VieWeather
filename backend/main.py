import asyncio
import csv
import gzip
import io
import json
import logging
import os
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from .budget import FORECAST_BUDGET, BudgetExhausted
from .field import DEFAULT_MODEL, FIELD_TTL, FieldCache, MODEL_IDS, WEATHER_MODELS
from .places import load_places
from .places import summary as places_summary
from .weather import (
    CURRENT,
    HOURLY,
    DAILY,
    AIR,
    SEVERITY_ORDER,
    demo_weather,
    parse_live,
    observation,
    parse_air_quality,
    search_cities,
)

ROOT = Path(__file__).resolve().parents[1]
# Vietnamese place names carry diacritics, so every file read states UTF-8 explicitly
# instead of relying on the platform default (cp1252 on Windows).
CITIES = json.loads((ROOT / "backend/cities.json").read_text(encoding="utf-8"))
CITY_BY_ID = {c["id"]: c for c in CITIES}
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
# Cities read the same model as the map field, which is also what Windy shows, so
# the panel temperature and the field temperature next to it tell the same story.
CITY_MODEL = "ecmwf_ifs025"
# ECMWF does not publish these, so they are fetched separately and merged in.
EXTRA_CURRENT = "visibility,uv_index"
EXTRA_DAILY = "uv_index_max"
EXTRA_MODEL = "best_match"
# Provider budget, in the units the Open-Meteo headers meter (see backend/budget.py):
# a "current + hourly + daily" call costs ~2.9 per coordinate, the small
# visibility/UV call a fraction of that, and a current-only grid point 1.0.
CITY_UNITS_PER_POINT = 3.2
EXTRAS_UNITS_PER_POINT = 0.6
RESERVE_TIMEOUT = 40.0  # a background poll may wait this long for provider budget
# Ordering gap only: the grid prefetch takes its units first. The token bucket, not
# this delay, is what guarantees the budget.
STARTUP_GRACE = 10
FIELD_RETRY = 75  # seconds; retry sooner than a full cycle after a deferral
# Keep a third of the hourly window in reserve: manual model switching, a restart or
# a teammate's probe should never be able to starve the city poll.
GRID_HOUR_FLOOR = 1500.0
DATA = Path(os.getenv("DATA_DIR", str(ROOT / "data")))
MODE = os.getenv("WEATHER_MODE", "live")
log = logging.getLogger("vieweather")


class Store:
    def __init__(self, folder):
        self.folder = Path(folder)
        (self.folder / "incoming").mkdir(parents=True, exist_ok=True)
        self.db = self.folder / "weather.sqlite"
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute(
                "CREATE TABLE IF NOT EXISTS observations (event_id TEXT PRIMARY KEY, city_id TEXT, region TEXT, event_time TEXT, ingested_at TEXT, source TEXT, temperature REAL, humidity REAL, wind REAL, precipitation REAL)"
            )
            db.execute(
                "CREATE INDEX IF NOT EXISTS idx_city_time ON observations(city_id,event_time)"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS forecasts (city_id TEXT PRIMARY KEY, payload TEXT)"
            )
        self.cache = {}
        with self.connect() as db:
            for row in db.execute("SELECT city_id,payload FROM forecasts"):
                self.cache[row["city_id"]] = json.loads(row["payload"])
        self.sequence = 0
        self.last_error = None
        self.last_poll = None
        self.air_quality_ok = bool(
            any(w.get("airQuality") for w in self.cache.values())
        )

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.db, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def save(self, forecasts):
        # Publish before SQLite commit: a crash can replay events, which Spark deduplicates.
        events = [observation(w) for w in forecasts]
        with self.connect() as db:
            fresh = [
                e
                for e in events
                if not db.execute(
                    "SELECT 1 FROM observations WHERE event_id=?", (e["event_id"],)
                ).fetchone()
            ]
            if fresh:
                name = (
                    self.folder
                    / "incoming"
                    / f"{time.time_ns()}-{uuid.uuid4().hex}.json"
                )
                tmp = name.with_suffix(".tmp")
                tmp.write_text(
                    "\n".join(json.dumps(e) for e in fresh) + "\n", encoding="utf-8"
                )
                tmp.replace(name)
            for e in events:
                db.execute(
                    "INSERT OR IGNORE INTO observations VALUES (:event_id,:city_id,:region,:event_time,:ingested_at,:source,:temperature,:humidity,:wind,:precipitation)",
                    e,
                )
            for w in forecasts:
                db.execute(
                    "INSERT OR REPLACE INTO forecasts VALUES (?,?)",
                    (w["city"]["id"], json.dumps(w)),
                )
                self.cache[w["city"]["id"]] = w
        self.air_quality_ok = any(w.get("airQuality") for w in forecasts)
        self.sequence += 1
        self.last_poll = datetime.now(timezone.utc).isoformat()

    def snapshot(self):
        result = []
        now = datetime.now(timezone.utc)
        for city in CITIES:
            w = self.cache.get(city["id"])
            if w:
                age = (
                    now
                    - datetime.fromisoformat(
                        w["fetchedAt"].replace("Z", "+00:00")
                    )
                ).total_seconds()
                # The city block is re-attached from cities.json on every read. A
                # row cached before a rename (an island name gaining its diacritics,
                # say) would otherwise keep serving the old label until the next poll.
                result.append({**w, "city": city, "stale": age > 1800})
        return result


async def fetch_air_quality(client, cities=None):
    """Batch air quality for every city. Returns None when the provider is down."""
    cities = cities or CITIES
    params = {
        "latitude": ",".join(str(c["lat"]) for c in cities),
        "longitude": ",".join(str(c["lon"]) for c in cities),
        "current": AIR,
        "timezone": "Asia/Ho_Chi_Minh",
    }
    try:
        response = await client.get(AIR_QUALITY_URL, params=params)
        response.raise_for_status()
        rows = response.json()
        if not isinstance(rows, list) or len(rows) != len(cities):
            raise ValueError("Unexpected air quality response")
        return [parse_air_quality(row) for row in rows]
    except Exception as exc:  # air quality must never break the weather fetch
        log.warning("Air quality collection failed: %s", exc)
        return None


def _json(payload, request, max_age=600):
    """Compact JSON, gzipped when the client accepts it (field and places are big)."""
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
    headers = {
        "Cache-Control": f"public, max-age={max_age}",
        "Vary": "Accept-Encoding",
    }
    if "gzip" in request.headers.get("accept-encoding", "").lower():
        body = gzip.compress(body, 5)
        headers["Content-Encoding"] = "gzip"
    return Response(body, media_type="application/json", headers=headers)


class ProviderRateLimited(RuntimeError):
    """Provider budget exhausted or 429: a deferral, never an outage."""


def _retry_after(response, default=FIELD_RETRY):
    try:
        return float(response.headers.get("retry-after") or default)
    except (TypeError, ValueError):
        return float(default)


async def _reserve(units, label):
    try:
        await FORECAST_BUDGET.reserve(units, timeout=RESERVE_TIMEOUT)
    except BudgetExhausted as exc:
        raise ProviderRateLimited(label + " deferred: " + str(exc)) from exc


def _coordinates():
    return {
        "latitude": ",".join(str(c["lat"]) for c in CITIES),
        "longitude": ",".join(str(c["lon"]) for c in CITIES),
    }


async def fetch_city_rows(client):
    """ECMWF rows for every monitored city (the model Windy shows)."""
    await _reserve(len(CITIES) * CITY_UNITS_PER_POINT, "city poll")
    params = {
        **_coordinates(),
        "current": CURRENT,
        "hourly": HOURLY,
        "daily": DAILY,
        "timezone": "Asia/Ho_Chi_Minh",
        "timeformat": "unixtime",
        "forecast_days": 7,
        "models": CITY_MODEL,
    }
    response = await client.get(FORECAST_URL, params=params)
    if response.status_code == 429:
        FORECAST_BUDGET.drain(_retry_after(response))
        raise ProviderRateLimited("city poll rate limited")
    response.raise_for_status()
    rows = response.json()
    if not isinstance(rows, list) or len(rows) != len(CITIES):
        raise ValueError("Unexpected provider response")
    return rows


async def fetch_extras(client):
    """Visibility and UV come from a different model, because ECMWF omits them.

    A failure here must not take the whole cycle down: the city payload simply
    keeps its documented defaults for those four numbers.
    """
    await _reserve(len(CITIES) * EXTRAS_UNITS_PER_POINT, "visibility/UV poll")
    params = {
        **_coordinates(),
        "current": EXTRA_CURRENT,
        "daily": EXTRA_DAILY,
        "timezone": "Asia/Ho_Chi_Minh",
        "timeformat": "unixtime",
        "forecast_days": 7,
        "models": EXTRA_MODEL,
    }
    try:
        response = await client.get(FORECAST_URL, params=params)
        if response.status_code == 429:
            FORECAST_BUDGET.drain(_retry_after(response))
            raise ProviderRateLimited("visibility/UV poll rate limited")
        response.raise_for_status()
        rows = response.json()
        if not isinstance(rows, list) or len(rows) != len(CITIES):
            raise ValueError("Unexpected extras response")
        return rows
    except Exception as exc:
        log.warning("Supplementary visibility/UV fetch failed: %s", exc)
        return None


async def poll_cities(store):
    """One collection cycle. Returns True when the provider actually answered.

    Never raises, and never turns a deferral into an outage: if the provider budget
    is momentarily full the caller retries in ~75 s, the UI keeps reading the last
    saved snapshot and no "provider unavailable" banner appears.
    """
    if MODE == "demo":
        store.save([demo_weather(c) for c in CITIES])
        store.last_error = None
        return True
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            rows, extras = await asyncio.gather(
                fetch_city_rows(client), fetch_extras(client)
            )
            air = await fetch_air_quality(client)
            store.air_quality_ok = air is not None
            store.save(
                [
                    parse_live(
                        city,
                        data,
                        air=air[index] if air else None,
                        extras=extras[index] if extras else None,
                    )
                    for index, (city, data) in enumerate(zip(CITIES, rows))
                ]
            )
        store.last_error = None
        return True
    except ProviderRateLimited as exc:
        # Budget, not breakage: keep the last snapshot and say nothing scary.
        log.warning("City poll deferred: %s", exc)
        return False
    except Exception as exc:
        log.warning("Weather collection failed: %s", exc)
        store.last_error = (
            "Weather provider unavailable. Cached or labeled demo data is shown."
        )
        return False


async def collect_cities(store):
    """The 10 minute city cadence, with a faster retry after a deferral."""
    cycle = 10 if MODE == "demo" else 600
    retry = 10 if MODE == "demo" else FIELD_RETRY
    if MODE != "demo":
        await asyncio.sleep(STARTUP_GRACE)  # let the grid prefetch reserve first
    while True:
        ok = await poll_cities(store)
        await asyncio.sleep(cycle if ok else retry)


def _grid_is_live(fields):
    entry = fields.entries.get(DEFAULT_MODEL)
    return entry is not None and entry["source"] == "live"


async def collect_field(fields):
    """Keep the dense grid warm on the same 10 minute cadence.

    Runs as its own task so the grid and the city poll can never interleave into one
    over-budget minute; the shared token bucket enforces that even if they do.

    A boot that lands while the provider is still busy must not leave the map on
    synthesized colours for a whole 10 minute cycle: until the cache holds a real
    grid, retry on the short cadence instead.
    """
    await fields.prefetch(DEFAULT_MODEL)
    while True:
        await asyncio.sleep(FIELD_TTL if _grid_is_live(fields) else FIELD_RETRY)
        if FORECAST_BUDGET.available_in(1) < GRID_HOUR_FLOOR:
            # Something else spent the hour: skip one beat, keep the old grid.
            log.warning("Hourly provider budget low; skipping this grid refresh")
            await asyncio.sleep(FIELD_RETRY)
        await fields.prefetch(DEFAULT_MODEL)


@asynccontextmanager
async def lifespan(app):
    if MODE not in ("live", "demo"):
        raise RuntimeError("WEATHER_MODE must be live or demo")
    store = Store(DATA)
    if not store.cache:
        # Bootstrap is explicitly synthetic and remains labeled in every response.
        store.save([demo_weather(c) for c in CITIES])
    app.state.store = store
    # Dense gridded field: warm the default model, then let collect() keep it fresh.
    fields = FieldCache(MODE, folder=DATA)
    app.state.fields = fields
    load_places()  # parse the gazetteer once at startup, not on the first map load
    # Two independent cadences: cities every 10 minutes, grid every 10 minutes,
    # off-phase, both gated by the shared provider budget.
    tasks = [
        asyncio.create_task(collect_field(fields)),
        asyncio.create_task(collect_cities(store)),
    ]
    yield
    for task in tasks:
        task.cancel()
    for pending in list(fields.tasks.values()):
        pending.cancel()
    for task in tasks:
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="VieWeather API", version="1.0.0", lifespan=lifespan)


@app.get("/api/health")
def health(request: Request):
    s = request.app.state.store
    fields = getattr(request.app.state, "fields", None)
    grid = None
    if fields is not None:
        entry = fields.snapshot().get(DEFAULT_MODEL)
        grid = {
            "model": DEFAULT_MODEL,
            "cityModel": CITY_MODEL,
            "models": list(MODEL_IDS),
            "grid": entry,
            "error": fields.last_error,
            "warning": fields.last_warning,
            "budget": FORECAST_BUDGET.snapshot(),
            "places": places_summary(),
        }
    return {
        "status": "ok",
        "mode": MODE,
        "lastPoll": s.last_poll,
        "providerError": s.last_error,
        "airQuality": "available" if s.air_quality_ok else "unavailable",
        "field": grid,
    }


@app.get("/api/weather")
def weather(request: Request):
    s = request.app.state.store
    return {
        "cities": s.snapshot(),
        "sequence": s.sequence,
        "providerError": s.last_error,
        "mode": MODE,
        # Which forecast the city numbers come from, so the UI never has to guess.
        "model": CITY_MODEL,
    }


@app.get("/api/history/{city_id}")
def history(
    city_id: str,
    request: Request,
    hours: int = Query(24, ge=1, le=168),
    source: str = Query("open-meteo", pattern="^(open-meteo|demo)$"),
):
    if city_id not in {c["id"] for c in CITIES}:
        raise HTTPException(404, "Unknown city")
    with request.app.state.store.connect() as db:
        rows = db.execute(
            "SELECT * FROM observations WHERE city_id=? AND source=? AND julianday(event_time)>=julianday('now',?) ORDER BY event_time LIMIT 10000",
            (city_id, source, f"-{hours} hours"),
        ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/analytics")
def analytics(request: Request):
    s = request.app.state.store
    with s.connect() as db:
        counts = [
            dict(r)
            for r in db.execute(
                "SELECT source, COUNT(*) AS events, COUNT(DISTINCT city_id) AS cities FROM observations GROUP BY source"
            )
        ]
        recent = [
            dict(r)
            for r in db.execute(
                "SELECT * FROM observations ORDER BY ingested_at DESC LIMIT 12"
            )
        ]
        regions = [
            dict(r)
            for r in db.execute(
                "SELECT region,source,COUNT(*) AS events,ROUND(AVG(temperature),1) AS temperature,ROUND(AVG(humidity),1) AS humidity,ROUND(MAX(wind),1) AS maxWind FROM observations WHERE julianday(event_time)>julianday('now','-1 hour') GROUP BY region,source"
            )
        ]
    spark = {"status": "not connected", "windows": [], "updatedAt": None, "queries": []}
    files = (
        sorted(
            (s.folder / "gold").glob("batch-*.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if (s.folder / "gold").exists()
        else []
    )
    if files:
        try:
            payload = json.loads(files[0].read_text(encoding="utf-8"))
            age = time.time() - files[0].stat().st_mtime
            spark = {
                "status": "recent output" if age < 120 else "idle",
                "windows": payload["windows"],
                "updatedAt": payload["processedAt"],
                "batchId": payload["batchId"],
                "queries": [],
            }
        except (OSError, ValueError, KeyError):
            spark["status"] = "output unavailable"
    status_file = s.folder / "spark-status.json"
    if status_file.exists():
        try:
            status = json.loads(status_file.read_text(encoding="utf-8"))
            spark["queries"] = status["queries"]
            spark["heartbeatAt"] = status["updatedAt"]
            spark["status"] = (
                "active"
                if time.time() - status_file.stat().st_mtime < 45
                and all(q["active"] for q in status["queries"])
                else "disconnected"
            )
        except (OSError, ValueError, KeyError):
            pass
    return {
        "counts": counts,
        "recent": recent,
        "regions": regions,
        "spark": spark,
        "lastPoll": s.last_poll,
        "mode": MODE,
        "providerError": s.last_error,
        "incomingFiles": len(list((s.folder / "incoming").glob("*.json"))),
    }


@app.get("/api/export")
def export(request: Request):
    with request.app.state.store.connect() as db:
        rows = db.execute(
            "SELECT * FROM observations ORDER BY event_time DESC LIMIT 100000"
        ).fetchall()
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(
        [
            "event_id",
            "city_id",
            "region",
            "event_time",
            "ingested_at",
            "source",
            "temperature",
            "humidity",
            "wind",
            "precipitation",
        ]
    )
    writer.writerows([tuple(r) for r in rows])
    return Response(
        out.getvalue(),
        media_type="text/csv",
        headers={
            "Content-Disposition": "attachment; filename=vieweather-observations.csv"
        },
    )


@app.get("/api/events")
async def events(request: Request):
    async def stream():
        previous = -1
        while not await request.is_disconnected():
            s = request.app.state.store
            if previous != s.sequence:
                previous = s.sequence
                yield f"event: weather\ndata: {json.dumps({'sequence':previous})}\n\n"
            else:
                yield ": heartbeat\n\n"
            await asyncio.sleep(5)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/air-quality/{city_id}")
def air_quality(city_id: str, request: Request):
    """AirQuality block for one city, or 404 when the provider has no reading."""
    if city_id not in CITY_BY_ID:
        raise HTTPException(404, "Unknown city")
    block = (request.app.state.store.cache.get(city_id) or {}).get("airQuality")
    if not block:
        raise HTTPException(404, "Air quality unavailable for this city")
    return block


@app.get("/api/cities/search")
def cities_search(
    q: str = Query("", max_length=64),
    limit: int = Query(8, ge=1, le=25),
):
    """Ranked, accent-insensitive city search for the command palette."""
    return search_cities(CITIES, q, limit)


@app.get("/api/alerts")
def alerts(request: Request):
    """Every active alert across the monitored cities, most severe first."""
    cache = request.app.state.store.cache
    items = []
    for city in CITIES:
        for alert in (cache.get(city["id"]) or {}).get("alerts") or []:
            items.append(
                {**alert, "city_id": city["id"], "city_name": city["name"]}
            )
    items.sort(
        key=lambda a: (-SEVERITY_ORDER.get(a["severity"], 0), a["starts"], a["id"])
    )
    return items


@app.get("/api/field")
async def field(request: Request, model: str = Query(DEFAULT_MODEL)):
    """Dense gridded weather field across Vietnam for one forecast model.

    Points are row-major (index = row * cols + col), row 0 = south edge, column 0 =
    the west edge, which is how the client interpolates the map layer. An unknown
    model id is a client error, not a silent fallback.
    """
    if model not in MODEL_IDS:
        raise HTTPException(
            400,
            "Unknown model '" + model + "'. Use one of: " + ", ".join(MODEL_IDS),
        )
    payload = await request.app.state.fields.get(model)
    return _json(payload, request, max_age=120)


@app.get("/api/places")
def places(request: Request):
    """Vietnam gazetteer for the on-map temperature labels (rank 1..4)."""
    return _json(load_places(), request, max_age=3600)


@app.get("/api/models")
def models(request: Request):
    """Forecast models the UI can pick, mirroring WEATHER_MODELS in src/types.ts."""
    return _json(WEATHER_MODELS, request, max_age=86400)


if (ROOT / "dist").exists():
    app.mount("/", StaticFiles(directory=ROOT / "dist", html=True), name="frontend")