"""Dense gridded weather field for the map (GET /api/field).

The map used to blur 25 city readings with inverse-distance weighting. This module
samples a regular lat/lon grid straight from the weather provider instead, so every
cell of the field is its own model value and the contour actually follows the
terrain: cooler highlands, warmer basins, the rain shadow behind the Truong Son.

The grid is 20 x 17 = 340 points over lon 102.0-109.8 / lat 8.6-23.4 (~0.4 deg
spacing): dense enough that every contour follows the terrain - cooler highlands,
warmer basins, the rain shadow behind the Truong Son - while still fitting inside a
single 60 s provider budget window, which the earlier 26x22 grid (572 points, 95 % of
a minute on its own) did not. See backend/budget.py for why that matters.

One URL cannot carry every coordinate (a 572-point URL is rejected with 414), so the
grid is fetched in chunks of 200 that run concurrently: a full refresh is one round
trip. If the provider is unhappy the cache keeps serving the last good grid with
"stale": true and never turns a map layer into a 500.

Model selection matters for the user's complaint that the numbers differ from
Windy: Windy reads ECMWF, which is why "ecmwf_ifs025" is the default model here.

Measured agreement, Ha Noi, 2026-11-09 18:00Z (same instant, one provider call):

    model            temperature   humidity
    best_match          17.3 C       54 %      (what the app used to show)
    ecmwf_ifs025        16.1 C       74 %      (what Windy shows - now our default)
    icon_seamless       16.7 C       85 %

After switching the city payload to ECMWF as well, the grid cell nearest Ha Noi
(21.29N 105.74E) read 16.9 C and the city payload 16.2 C / 73 % RH - a 0.7 C
difference explained by the grid cell sitting ~30 km north-west of the city, and
humidity now matching what Windy reports instead of being 20 points dry.

Budget note for whoever touches this next: every refresh reserves its units from
backend/budget.py *before* it touches the network, against both provider windows
(600/minute and 5000/hour). A 340-point grid is 408 reserved units, so it can never
collide with the 25-city poll, and a 429 hands the whole window back instead of
retrying. Do not grow the grid without redoing that arithmetic: at 340 points the
10 minute cadence spends about 2,500 of the 5,000 hourly units, and the collector
also refuses a refresh when the hour is running low so a user switching models is
never starved.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from datetime import datetime, timezone

import httpx

from .budget import FORECAST_BUDGET, BudgetExhausted
from .weather import VN, _num, iso

log = logging.getLogger("vieweather.field")

FIELD_URL = "https://api.open-meteo.com/v1/forecast"
FIELD_VARS = (
    "temperature_2m,relative_humidity_2m,precipitation,weather_code,"
    "wind_speed_10m,wind_direction_10m,is_day"
)

# Regular grid across the whole country, extended east so the Hoang Sa and
# Truong Sa archipelagos sit inside the sampled field instead of on its feathered
# edge: Ta Lung in the west to the Truong Sa shelf in the east, Ca Mau cape in the
# south to Lung Cu in the north.
GRID_BOUNDS = (102.0, 8.6, 114.5, 23.4)  # west, south, east, north
GRID_COLS = 24
GRID_ROWS = 17
COARSE_COLS = 10
COARSE_ROWS = 9
BATCH = 200  # coordinates per request; keeps the URL near 4 kB (572 fails with 414)
# One grid refresh must stay well inside a single 60 s provider window (600 units),
# leaving room for the city poll and the visibility/UV supplement in the same
# minute: 24 x 17 = 408 points reserves 489.6 units of 600, and the 27-location city
# poll plus its visibility/UV supplement reserve 102.6 more, so one cold start is
# 592.2 units - inside the window by construction. The east edge still reaches
# 114.5 E, so the archipelagos stay inside the sampled grid.
BUDGET_PER_POINT = 1.2  # reserved units per coordinate (measured cost is 1.0)
REQUEST_BUDGET_WAIT = 20.0  # seconds a foreground request may wait for tokens
FIELD_TTL = 570  # seconds; just under the 10 minute collector cadence
FALLBACK_TTL = 45  # retry the provider sooner after a failure
BUSY_COOLDOWN = 60  # seconds to stay off the provider after a 429
DEFAULT_MODEL = "ecmwf_ifs025"

# Provenance labels, so health/UI never has to guess what it is looking at:
#   live       real provider data at the full 20x17 grid
#   coarse     real provider data at the reduced grid (full-resolution call failed)
#   cache      real data, but older than the TTL and served while a refresh runs
#   synthetic  generated locally (demo mode, or a cold start with no provider)
SOURCE_LIVE = "live"
SOURCE_COARSE = "coarse"
SOURCE_CACHE = "cache"
SOURCE_SYNTHETIC = "synthetic"

# Mirrors WEATHER_MODELS in src/types.ts so the UI can show which forecast it reads.
WEATHER_MODELS = [
    {"id": "ecmwf_ifs025", "label": "ECMWF", "detail": "European centre · 0.25°"},
    {"id": "best_match", "label": "Blend", "detail": "Best match · multi-model"},
    {"id": "icon_seamless", "label": "ICON", "detail": "DWD Germany · seamless"},
    {"id": "gfs_seamless", "label": "GFS", "detail": "NOAA · seamless"},
]
MODEL_IDS = tuple(model["id"] for model in WEATHER_MODELS)


def grid_points(cols=GRID_COLS, rows=GRID_ROWS, bounds=GRID_BOUNDS):
    """Row-major sample coordinates: index = row * cols + col.

    Row 0 is the southern edge and the last row the northern edge; column 0 is the
    western edge. The client relies on this to place the field on the map, so the
    coordinates travel in the payload as well.
    """
    west, south, east, north = bounds
    points = []
    for row in range(rows):
        lat = round(south + (north - south) * row / (rows - 1), 4) if rows > 1 else south
        for col in range(cols):
            lon = round(west + (east - west) * col / (cols - 1), 4) if cols > 1 else west
            points.append((lat, lon))
    return points


def _value(value, default, digits=1):
    number = _num(value)
    return default if number is None else round(number, digits)


def _whole(value, default):
    number = _num(value)
    return default if number is None else int(round(number))


def parse_point(lat, lon, row):
    """One provider row -> FieldPoint. Never emits null: the field must stay numeric."""
    current = (row or {}).get("current") or {}
    return {
        "lat": lat,
        "lon": lon,
        "temperature": _value(current.get("temperature_2m"), 0.0, 1),
        "precipitation": _value(current.get("precipitation"), 0.0, 2),
        "wind": _value(current.get("wind_speed_10m"), 0.0, 1),
        "windDirection": _whole(current.get("wind_direction_10m"), 0) % 360,
        "code": _whole(current.get("weather_code"), 0),
        "isDay": bool(_whole(current.get("is_day"), 1)),
        "humidity": max(0, min(100, _whole(current.get("relative_humidity_2m"), 60))),
    }


def _payload(model, cols, rows, bounds, points, observed_at, stale=False):
    return {
        "model": model,
        "observedAt": observed_at,
        "fetchedAt": iso(datetime.now(timezone.utc)),
        "stale": bool(stale),
        "cols": cols,
        "rows": rows,
        "bounds": [bounds[0], bounds[1], bounds[2], bounds[3]],
        "points": points,
    }


def _observed_at(rows, now):
    """Provider valid time: the first row carries the shared timestamp."""
    for row in rows:
        current = (row or {}).get("current") or {}
        stamp = current.get("time")
        if isinstance(stamp, (int, float)):
            return iso(datetime.fromtimestamp(float(stamp), timezone.utc))
        if isinstance(stamp, str) and stamp:
            text = stamp if stamp.endswith("Z") or "+" in stamp else stamp + "+00:00"
            try:
                return iso(datetime.fromisoformat(text))
            except ValueError:
                continue
    return iso(now.replace(minute=0, second=0, microsecond=0))


class ProviderBusy(RuntimeError):
    """The provider refused on rate-limit grounds; back off instead of retrying."""

    def __init__(self, retry_after):
        super().__init__("field provider rate limited")
        self.retry_after = retry_after


async def _chunk(client, sample, model):
    params = {
        "latitude": ",".join(str(lat) for lat, _ in sample),
        "longitude": ",".join(str(lon) for _, lon in sample),
        "current": FIELD_VARS,
        "timezone": "UTC",
        "timeformat": "unixtime",
        "models": model,
    }
    response = await client.get(FIELD_URL, params=params)
    if response.status_code == 429:
        # Should not happen now that _fetch reserves its units first, but if the
        # provider disagrees about the cost, believe it: drain the bucket and let the
        # cache serve its last good grid instead of retrying into a closed door.
        retry_after = float(response.headers.get("retry-after") or BUSY_COOLDOWN)
        FORECAST_BUDGET.drain(retry_after)
        raise ProviderBusy(retry_after)
    response.raise_for_status()
    rows = response.json()
    if isinstance(rows, dict):  # provider errors come back as a JSON object
        raise ValueError(str(rows.get("reason") or rows)[:200])
    if not isinstance(rows, list) or len(rows) != len(sample):
        raise ValueError("Unexpected field response: " + str(len(rows)) + " rows")
    return rows


async def _fetch(client, model, cols, rows, bounds, reserve_timeout=None):
    sample = grid_points(cols, rows, bounds)
    # Reserve the whole refresh up front, so the chunks cannot race another caller
    # for the same minute of provider budget.
    try:
        await FORECAST_BUDGET.reserve(len(sample) * BUDGET_PER_POINT, timeout=reserve_timeout)
    except BudgetExhausted as exc:
        raise ProviderBusy(exc.wait) from exc
    chunks = [sample[i : i + BATCH] for i in range(0, len(sample), BATCH)]
    results = await asyncio.gather(
        *(_chunk(client, chunk, model) for chunk in chunks), return_exceptions=True
    )
    for result in results:
        if isinstance(result, ProviderBusy):
            raise result
    if any(isinstance(result, Exception) for result in results):
        # One provider hiccup should not throw the whole grid away: retry the
        # failed chunks once, a moment later, before giving up.
        await asyncio.sleep(1.5)
        retried = []
        for chunk, result in zip(chunks, results):
            if isinstance(result, Exception):
                retried.append(await _chunk(client, chunk, model))
            else:
                retried.append(result)
        results = retried
    provider_rows = [row for result in results for row in result]
    now = datetime.now(timezone.utc)
    points = [
        parse_point(lat, lon, row)
        for (lat, lon), row in zip(sample, provider_rows)
    ]
    return _payload(model, cols, rows, bounds, points, _observed_at(provider_rows, now))


def demo_point(lat, lon, now=None):
    """Deterministic, smooth synthetic field point for demo mode and last resorts.

    Only used when the provider is unreachable (or WEATHER_MODE=demo); it keeps the
    map layer populated and is always labelled stale by the caller.
    """
    now = now or datetime.now(timezone.utc)
    local = now.astimezone(VN)
    hour = local.hour + local.minute / 60.0
    # Coarse but plausible geography: warmer in the south, cooler highlands in the
    # central spine, a smooth diurnal cycle and a monsoon-ish humidity gradient.
    spine = math.exp(-(((lon - 107.6) / 1.1) ** 2)) * max(0.0, 1 - abs(lat - 15) / 9)
    temperature = (
        28.6
        - 0.44 * (lat - 10.0)
        - 3.1 * spine
        + 3.4 * math.sin((hour - 9.0) / 24.0 * 2 * math.pi)
        + 0.9 * math.sin(lon * 1.7 + lat * 0.6)
    )
    humidity = 74 - 14 * math.sin((hour - 12.0) / 24.0 * 2 * math.pi) + 6 * math.cos(lat * 0.8)
    wind = 9.5 + 6.5 * math.sin(lon * 0.6 + lat * 0.35) + 2.0 * math.cos(hour / 24 * 2 * math.pi)
    direction = (215 + 70 * math.sin(lat * 0.7) + 25 * math.cos(lon * 0.5)) % 360
    rain = max(0.0, 2.6 * math.sin(lat * 1.1 + lon * 0.7) - 1.1)
    if rain > 1.6:
        code = 65
    elif rain > 0.4:
        code = 61
    elif humidity > 85:
        code = 3
    elif humidity > 70:
        code = 2
    else:
        code = 1
    return {
        "lat": lat,
        "lon": lon,
        "temperature": round(temperature, 1),
        "precipitation": round(rain, 2),
        "wind": round(max(0.4, wind), 1),
        "windDirection": int(round(direction)) % 360,
        "code": code,
        "isDay": 6 <= hour < 18,
        "humidity": int(max(18, min(100, round(humidity)))),
    }


def demo_field(model=DEFAULT_MODEL, cols=GRID_COLS, rows=GRID_ROWS, bounds=GRID_BOUNDS, now=None):
    now = now or datetime.now(timezone.utc)
    observed = now.replace(minute=now.minute - now.minute % 15, second=0, microsecond=0)
    points = [demo_point(lat, lon, now) for lat, lon in grid_points(cols, rows, bounds)]
    payload = _payload(model, cols, rows, bounds, points, iso(observed), stale=True)
    payload["source"] = SOURCE_SYNTHETIC
    return payload


class FieldCache:
    """In-memory grid cache with stale-while-revalidate semantics.

    * fresh entry (younger than the TTL) -> served as is, stale: false
    * expired entry -> served immediately, stale: true, refreshed in the background
    * no entry -> awaited refresh, so the very first request is still correct
    """

    def __init__(self, mode="live", ttl=FIELD_TTL, folder=None):
        self.mode = mode
        self.ttl = ttl
        self.folder = folder  # optional directory for the last-good-grid snapshot
        self.entries = {}  # model -> {"payload", "at", "source"}
        self.locks = {}
        self.tasks = {}
        self.last_error = None  # genuine provider outage
        self.last_warning = None  # rate limiting / budget, which is not an outage
        self.busy_until = 0.0  # monotonic deadline set after a provider 429
        self._restore()

    # -- disk persistence ---------------------------------------------------
    # A restart used to lose the last real grid and drop the map to synthesized
    # colours even though real data was a minute old. The snapshot below makes a
    # cold start keep serving the last honest grid while the provider is busy.
    def _snapshot_path(self, model):
        if not self.folder:
            return None
        return self.folder / ("field-" + model + ".json")

    def _restore(self):
        if not self.folder:
            return
        for model in MODEL_IDS:
            path = self._snapshot_path(model)
            try:
                if not path or not path.exists():
                    continue
                saved = json.loads(path.read_text(encoding="utf-8"))
                payload = saved["payload"]
                if not payload.get("points"):
                    continue
                written = float(saved["written"])
                age = max(0.0, time.time() - written)
                self.entries[model] = {
                    "payload": payload,
                    "at": time.monotonic() - age,
                    "source": saved.get("source", SOURCE_LIVE),
                }
                log.info("Restored %s field grid from disk (%.0f s old)", model, age)
            except (OSError, ValueError, KeyError) as exc:
                log.warning("Could not restore %s field grid: %s", model, exc)

    def _persist(self, model, entry):
        path = self._snapshot_path(model)
        if not path:
            return
        if entry["source"] not in (SOURCE_LIVE, SOURCE_COARSE):
            return  # never snapshot synthesized colours
        try:
            self.folder.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(
                json.dumps(
                    {
                        "payload": entry["payload"],
                        "source": entry["source"],
                        "written": time.time(),
                    }
                ),
                encoding="utf-8",
            )
            tmp.replace(path)
        except (OSError, TypeError, ValueError) as exc:
            log.warning("Could not persist %s field grid: %s", model, exc)

    # -- internals ---------------------------------------------------------
    def _lock(self, model):
        lock = self.locks.get(model)
        if lock is None:
            lock = self.locks[model] = asyncio.Lock()
        return lock

    def age(self, model):
        entry = self.entries.get(model)
        return None if entry is None else time.monotonic() - entry["at"]

    @staticmethod
    def report_source(entry, stale):
        """Honest label for a cache entry: what it is, and whether it is old."""
        if entry["source"] == SOURCE_SYNTHETIC:
            return SOURCE_SYNTHETIC
        if stale:
            return SOURCE_CACHE
        return SOURCE_COARSE if entry["source"] == SOURCE_COARSE else SOURCE_LIVE

    def _serve(self, model, stale):
        entry = self.entries.get(model)
        if entry is None:
            return None
        payload = dict(entry["payload"])
        payload["stale"] = bool(stale) or entry["source"] != SOURCE_LIVE
        # Provenance travels with the payload so a client can tell real data from
        # synthesized colours and prefer its own honest fallback.
        payload["source"] = self.report_source(entry, stale)
        return payload

    def _provider_available(self):
        return time.monotonic() >= self.busy_until

    def _cool_down(self, seconds):
        self.busy_until = max(
            self.busy_until, time.monotonic() + max(5.0, float(seconds or BUSY_COOLDOWN))
        )

    def _busy(self, wait, message):
        """Rate limiting is a warning, not an outage: the cached grid is still good."""
        self._cool_down(wait)
        self.last_warning = message
        log.warning("%s; serving the cached grid", message)

    async def _load(self, model, reserve_timeout=None):
        """Refresh one model, degrading to a coarse grid and then to synthesis.

        A provider failure never replaces a good grid: the last good payload stays in
        the cache and is served with stale: true, because a 10 minute old real reading
        is honest while a synthesized one is not.
        """
        async with self._lock(model):
            entry = self.entries.get(model)
            if entry is not None and time.monotonic() - entry["at"] < 3:
                return entry["payload"]  # another request just refreshed it
            if not self._provider_available():
                return None
            payload, source = None, SOURCE_LIVE
            async with httpx.AsyncClient(timeout=25) as client:
                try:
                    payload = await _fetch(
                        client,
                        model,
                        GRID_COLS,
                        GRID_ROWS,
                        GRID_BOUNDS,
                        reserve_timeout=reserve_timeout,
                    )
                except ProviderBusy as exc:
                    self._busy(exc.retry_after, "Field provider rate limited")
                    return None
                except Exception as exc:
                    log.warning("Dense field fetch failed (%s): %s", model, exc)
                    try:
                        payload = await _fetch(
                            client,
                            model,
                            COARSE_COLS,
                            COARSE_ROWS,
                            GRID_BOUNDS,
                            reserve_timeout=reserve_timeout,
                        )
                        source = SOURCE_COARSE
                        log.warning(
                            "Fell back to a %sx%s field grid", COARSE_COLS, COARSE_ROWS
                        )
                    except ProviderBusy as exc2:
                        self._busy(exc2.retry_after, "Field provider rate limited")
                        return None
                    except Exception as exc2:
                        self.last_error = "Field provider unavailable: " + str(exc2)[:160]
                        log.warning("Coarse field fetch failed (%s): %s", model, exc2)
                        if entry is not None:
                            return None  # keep the last good grid
                        payload = demo_field(model)
                        source = SOURCE_SYNTHETIC
            if payload is not None:
                self.entries[model] = {
                    "payload": payload,
                    "at": time.monotonic(),
                    "source": source,
                }
                if source in (SOURCE_LIVE, SOURCE_COARSE):
                    self.last_error = None
                    self.last_warning = None
                    self._persist(model, self.entries[model])
            return payload

    def _schedule(self, model):
        if not self._provider_available():
            return
        task = self.tasks.get(model)
        if task is not None and not task.done():
            return
        async def run():
            try:
                await self._load(model)
            except Exception as exc:  # pragma: no cover - defensive
                log.warning("Background field refresh failed: %s", exc)
        self.tasks[model] = asyncio.create_task(run())

    # -- public ------------------------------------------------------------
    async def get(self, model):
        if self.mode == "demo":
            payload = self._serve(model, False)
            if payload is None:
                self.entries[model] = {
                    "payload": demo_field(model),
                    "at": time.monotonic(),
                    "source": SOURCE_SYNTHETIC,
                }
                payload = self._serve(model, False)
            return payload
        entry = self.entries.get(model)
        if entry is None:
            # A browser request must not hang on the budget: wait a little, then
            # answer with the last good grid (or a labelled synthesis) instead.
            await self._load(model, reserve_timeout=REQUEST_BUDGET_WAIT)
            if model not in self.entries:
                # Nothing has ever been fetched and the provider is unavailable: a
                # synthesized grid labelled stale beats an empty map layer.
                self.entries[model] = {
                    "payload": demo_field(model),
                    "at": time.monotonic(),
                    "source": SOURCE_SYNTHETIC,
                }
            return self._serve(model, False)
        age = time.monotonic() - entry["at"]
        limit = FALLBACK_TTL if entry["source"] != "live" else self.ttl
        if age < limit:
            return self._serve(model, False)
        self._schedule(model)
        return self._serve(model, True)

    async def prefetch(self, model=DEFAULT_MODEL):
        if self.mode == "demo":
            await self.get(model)
            return
        try:
            await self._load(model)
        except Exception as exc:  # pragma: no cover - defensive
            log.warning("Field prefetch failed: %s", exc)

    def snapshot(self):
        """Health view: provenance, freshness and shape of every cached model."""
        now = time.monotonic()
        result = {}
        for model, entry in self.entries.items():
            age = now - entry["at"]
            limit = FALLBACK_TTL if entry["source"] == SOURCE_SYNTHETIC else self.ttl
            result[model] = {
                "cols": entry["payload"]["cols"],
                "rows": entry["payload"]["rows"],
                "source": self.report_source(entry, age >= limit),
                "stored": entry["source"],
                "age": round(age),
                "observedAt": entry["payload"]["observedAt"],
            }
        return result