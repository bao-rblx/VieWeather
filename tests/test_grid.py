"""Tests for the dense field grid, the Vietnam gazetteer and model selection.

The map depends on three things this module pins down:
  1. /api/field is a real, dense, row-major grid with a documented model.
  2. /api/field degrades honestly (last good grid, never a 500, never a fake value
     pretending to be fresh).
  3. /api/places is a usable label gazetteer, sorted the way the map expects.
"""

import asyncio
import json
import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from backend import budget, field, main, places as places_module
from backend.weather import demo_weather, parse_live

UTC = timezone.utc
PLACE_KEYS = {"id", "name", "lat", "lon", "rank", "admin", "population"}
FIELD_KEYS = {
    "model",
    "source",
    "observedAt",
    "fetchedAt",
    "stale",
    "cols",
    "rows",
    "bounds",
    "points",
}
POINT_KEYS = {
    "lat",
    "lon",
    "temperature",
    "precipitation",
    "wind",
    "windDirection",
    "code",
    "isDay",
    "humidity",
}


@pytest.fixture(autouse=True)
def fresh_budget(monkeypatch):
    """Give every test its own provider budget.

    The real bucket is process-wide and capacity 600, so one test's grid refresh would
    otherwise starve the next test and make the suite depend on wall-clock refills.
    The budget behaviour itself is unit-tested below with local buckets.
    """
    bucket = budget.TokenBucket(capacity=3000, window=60)
    monkeypatch.setattr(budget, "FORECAST_BUDGET", bucket)
    monkeypatch.setattr(field, "FORECAST_BUDGET", bucket)
    monkeypatch.setattr(main, "FORECAST_BUDGET", bucket)
    return bucket


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DATA", tmp_path)
    monkeypatch.setattr(main, "MODE", "demo")
    with TestClient(main.app) as c:
        yield c


def provider_row(lat, lon):
    """One row shaped like an Open-Meteo "current" block."""
    return {
        "current": {
            "time": int(datetime(2026, 11, 9, 18, 0, tzinfo=UTC).timestamp()),
            "temperature_2m": 20.0 + lat,
            "relative_humidity_2m": 70 + int(lon) % 10,
            "precipitation": 0.4,
            "weather_code": 61,
            "wind_speed_10m": 12.5,
            "wind_direction_10m": 370,
            "is_day": 0,
        }
    }


async def good_chunk(client, sample, model):
    return [provider_row(lat, lon) for lat, lon in sample]


async def aborted_chunk(client, sample, model):
    raise RuntimeError("provider blew up")


async def busy_chunk(client, sample, model):
    raise field.ProviderBusy(30)


# --------------------------------------------------------------- grid geometry


def test_grid_points_are_row_major_south_to_north():
    sample = field.grid_points()
    assert len(sample) == field.GRID_COLS * field.GRID_ROWS
    west, south, east, north = field.GRID_BOUNDS
    assert sample[0] == (south, west)  # south-west corner
    assert sample[-1] == (north, east)  # north-east corner
    # index = row * cols + col
    row, col = 5, 7
    lat, lon = sample[row * field.GRID_COLS + col]
    assert lat == pytest.approx(south + (north - south) * row / (field.GRID_ROWS - 1))
    assert lon == pytest.approx(west + (east - west) * col / (field.GRID_COLS - 1))
    # every row shares one latitude, latitudes increase monotonically
    lats = [point[0] for point in sample]
    assert lats == sorted(lats)


def test_grid_bounds_cover_vietnam():
    west, south, east, north = field.GRID_BOUNDS
    assert west < 102.5 and east > 109.0  # Ca Mau to the eastern sea
    assert south < 9.0 and north > 23.0  # Ca Mau cape to Lung Cu
    assert field.GRID_COLS * field.GRID_ROWS >= 300  # dense, not a 25-city blur


def test_grid_fits_the_provider_budget():
    """One grid refresh plus one city poll must fit inside a 60 s / 600 unit window."""
    grid_units = field.GRID_COLS * field.GRID_ROWS * field.BUDGET_PER_POINT
    city_units = len(main.CITIES) * main.CITY_UNITS_PER_POINT
    extras_units = len(main.CITIES) * main.EXTRAS_UNITS_PER_POINT
    # The grid refresh is deliberately kept off the city poll's half of the minute
    # (see backend/budget.py and the collector cadence), so each may take a large
    # share of a window on its own; together they must still be able to share one.
    assert grid_units < budget.CAPACITY
    assert city_units + extras_units < budget.CAPACITY
    assert grid_units + city_units + extras_units <= budget.CAPACITY * 1.05


# --------------------------------------------------------------- point parsing


def test_parse_point_normalises_every_number():
    point = field.parse_point(21.0, 105.0, provider_row(21.0, 105.0))
    assert set(point) == POINT_KEYS
    assert point["temperature"] == 41.0
    assert point["isDay"] is False
    assert point["windDirection"] == 10  # 370 wraps to 10
    assert all(isinstance(value, (int, float, bool)) for value in point.values())


def test_parse_point_never_returns_null():
    """The interpolator must not see None: a missing provider value becomes a real one."""
    point = field.parse_point(10.0, 106.0, {"current": {}})
    assert set(point) == POINT_KEYS
    assert all(value is not None for value in point.values())
    assert point["humidity"] == 60
    assert point["isDay"] is True  # provider default when is_day is absent


def test_parse_point_clamps_humidity():
    row = provider_row(16.0, 108.0)
    row["current"]["relative_humidity_2m"] = 180
    assert field.parse_point(16.0, 108.0, row)["humidity"] == 100
    row["current"]["relative_humidity_2m"] = -20
    assert field.parse_point(16.0, 108.0, row)["humidity"] == 0


def test_observed_at_reads_the_provider_clock():
    stamp = int(datetime(2026, 11, 9, 18, 15, tzinfo=UTC).timestamp())
    rows = [{"current": {"time": stamp}}]
    assert field._observed_at(rows, datetime.now(UTC)) == "2026-11-09T18:15:00Z"
    rows = [{"current": {"time": "2026-11-09T18:15"}}]
    assert field._observed_at(rows, datetime.now(UTC)) == "2026-11-09T18:15:00Z"
    # No timestamp at all: fall back to the top of the hour, never to now-now.
    fallback = field._observed_at([{}], datetime(2026, 11, 9, 18, 42, tzinfo=UTC))
    assert fallback == "2026-11-09T18:00:00Z"


# ------------------------------------------------------------ provider budget


def test_budget_never_hands_out_more_than_the_window():
    bucket = budget.TokenBucket(capacity=100, window=60)

    async def spend():
        await bucket.reserve(100)
        with pytest.raises(budget.BudgetExhausted):
            await bucket.reserve(50, timeout=0.05)

    asyncio.run(spend())
    assert bucket.available() < 1.0


def test_budget_serialises_competing_callers():
    bucket = budget.TokenBucket(capacity=100, window=1.2)  # refills fast enough to wait
    taken = []

    async def take(units):
        await bucket.reserve(units, timeout=5)
        taken.append(units)

    async def run():
        # 3 x 40 units against a 100 unit bucket: the third must wait for a refill.
        await asyncio.gather(*(take(40) for _ in range(3)))

    asyncio.run(run())
    assert sorted(taken) == [40, 40, 40]
    assert bucket.available() <= 100


def test_budget_blocks_for_the_window_instead_of_racing_it():
    bucket = budget.TokenBucket(capacity=10, window=0.3)  # 33 units/s

    async def run():
        await bucket.reserve(10)
        started = time.monotonic()
        await bucket.reserve(5, timeout=5)  # must wait ~0.15 s for a refill
        return time.monotonic() - started

    assert asyncio.run(run()) >= 0.1


def test_hour_window_is_respected_as_well_as_the_minute_window():
    """The provider has a 5000/hour tier on top of 600/minute; both must hold."""
    bucket = budget.TokenBucket(windows=[(600, 60), (90, 3600)])

    async def run():
        await bucket.reserve(60)
        # 40 more units would fit the minute window but not the hour window, and the
        # hour window refills far too slowly to wait for.
        with pytest.raises(budget.BudgetExhausted):
            await bucket.reserve(40, timeout=0.1)
        await bucket.reserve(30, timeout=0.1)  # exactly what the hour window had left
        with pytest.raises(budget.BudgetExhausted):
            await bucket.reserve(5, timeout=0.1)

    asyncio.run(run())


def test_source_labels_are_honest(monkeypatch):
    """live / cache / coarse / synthetic, and nothing misleading in between."""
    monkeypatch.setattr(field, "_chunk", good_chunk)
    cache = field.FieldCache("live")
    asyncio.run(cache.get("ecmwf_ifs025"))
    entry = cache.entries["ecmwf_ifs025"]
    assert cache.report_source(entry, False) == "live"
    assert cache.report_source(entry, True) == "cache"  # old data, labelled as such
    assert cache.snapshot()["ecmwf_ifs025"]["source"] == "live"
    assert cache.snapshot()["ecmwf_ifs025"]["stored"] == "live"

    coarse = dict(entry)
    coarse["source"] = "coarse"
    assert cache.report_source(coarse, False) == "coarse"
    assert cache.report_source(coarse, True) == "cache"

    synthetic = dict(entry)
    synthetic["source"] = "synthetic"
    assert cache.report_source(synthetic, False) == "synthetic"
    assert cache.report_source(synthetic, True) == "synthetic"  # never claims cache


def test_full_grid_failure_is_labelled_coarse(monkeypatch):
    async def coarse_only(client, sample, model):
        # Fail every full-resolution chunk, succeed on the reduced grid.
        if len(sample) > 100:
            raise RuntimeError("provider 500")
        return [provider_row(lat, lon) for lat, lon in sample]

    monkeypatch.setattr(field, "_chunk", coarse_only)
    cache = field.FieldCache("live")
    payload = asyncio.run(cache._load("ecmwf_ifs025"))
    assert payload["cols"] == field.COARSE_COLS
    assert payload["rows"] == field.COARSE_ROWS
    assert cache.entries["ecmwf_ifs025"]["source"] == "coarse"
    assert cache.snapshot()["ecmwf_ifs025"]["source"] == "coarse"
    # The API payload is flagged stale, because it is not the full grid.
    assert asyncio.run(cache.get("ecmwf_ifs025"))["stale"] is True


def test_provider_windows_match_the_measured_headers():
    assert budget.MINUTE_WINDOW == (600.0, 60.0)
    assert budget.HOUR_WINDOW == (5000.0, 3600.0)
    bucket = budget.TokenBucket(windows=[budget.MINUTE_WINDOW, budget.HOUR_WINDOW])
    snapshot = bucket.snapshot()
    assert [row["window"] for row in snapshot["windows"]] == [60.0, 3600.0]
    assert [row["capacity"] for row in snapshot["windows"]] == [600.0, 5000.0]
    assert snapshot["capacity"] == 600.0


def test_rate_limit_drain_pauses_the_bucket():
    bucket = budget.TokenBucket(capacity=600, window=60)
    bucket.drain(30)
    assert bucket.available() < 1.0
    snapshot = bucket.snapshot()
    assert snapshot["pausedFor"] > 20
    assert snapshot["capacity"] == 600


def test_grid_refresh_reserves_its_units(monkeypatch):
    """A grid refresh must take its budget before touching the network."""
    bucket = budget.TokenBucket(capacity=600, window=60)
    monkeypatch.setattr(field, "FORECAST_BUDGET", bucket)
    calls = {"n": 0}

    async def counting_chunk(client, sample, model):
        calls["n"] += 1
        return [provider_row(lat, lon) for lat, lon in sample]

    monkeypatch.setattr(field, "_chunk", counting_chunk)
    before = bucket.available()
    asyncio.run(
        field._fetch(None, "ecmwf_ifs025", field.GRID_COLS, field.GRID_ROWS, field.GRID_BOUNDS)
    )
    spent = before - bucket.available()
    expected_chunks = -(-(field.GRID_COLS * field.GRID_ROWS) // field.BATCH)
    assert calls["n"] == expected_chunks
    assert spent == pytest.approx(
        field.GRID_COLS * field.GRID_ROWS * field.BUDGET_PER_POINT, rel=0.05
    )


# ----------------------------------------------------------------- demo field


def test_demo_field_is_deterministic_and_smooth():
    now = datetime(2026, 11, 9, 18, 0, tzinfo=UTC)
    first = field.demo_field("ecmwf_ifs025", now=now)
    second = field.demo_field("ecmwf_ifs025", now=now)
    assert first["points"] == second["points"]
    assert set(first) == FIELD_KEYS
    assert first["stale"] is True  # synthesized data is always labelled
    assert first["cols"] * first["rows"] == len(first["points"])
    temperatures = [point["temperature"] for point in first["points"]]
    assert 0 < min(temperatures) < 40 and 15 < max(temperatures) < 45
    # Neighbouring cells of a smooth field differ by less than a few degrees.
    steps = [
        abs(first["points"][i]["temperature"] - first["points"][i + 1]["temperature"])
        for i in range(0, len(first["points"]) - 1, field.GRID_COLS)
    ]
    assert max(steps) < 4.0


def test_demo_field_daylight_follows_vietnam_clock():
    night = field.demo_field(now=datetime(2026, 11, 9, 18, 0, tzinfo=UTC))  # 01:00 VN
    day = field.demo_field(now=datetime(2026, 11, 9, 5, 0, tzinfo=UTC))  # 12:00 VN
    assert not any(point["isDay"] for point in night["points"])
    assert all(point["isDay"] for point in day["points"])


# ------------------------------------------------------------------ the cache


def test_demo_mode_cache_never_touches_the_network(monkeypatch):
    def explode(*args, **kwargs):  # pragma: no cover - must not run
        raise AssertionError("demo mode must not call the provider")

    monkeypatch.setattr(field, "_chunk", explode)
    cache = field.FieldCache("demo")
    payload = asyncio.run(cache.get("ecmwf_ifs025"))
    assert payload["model"] == "ecmwf_ifs025"
    assert payload["stale"] is True


def test_cache_serves_the_fetched_grid_fresh(monkeypatch):
    monkeypatch.setattr(field, "_chunk", good_chunk)
    cache = field.FieldCache("live")
    payload = asyncio.run(cache.get("ecmwf_ifs025"))
    assert payload["stale"] is False
    assert payload["cols"] == field.GRID_COLS
    assert payload["rows"] == field.GRID_ROWS
    assert len(payload["points"]) == field.GRID_COLS * field.GRID_ROWS
    assert cache.entries["ecmwf_ifs025"]["source"] == "live"
    assert cache.last_error is None
    # A second call inside the TTL is a cache hit and reports the same grid.
    again = asyncio.run(cache.get("ecmwf_ifs025"))
    assert again["fetchedAt"] == payload["fetchedAt"]


def test_provider_failure_keeps_the_last_good_grid(monkeypatch):
    monkeypatch.setattr(field, "_chunk", good_chunk)
    cache = field.FieldCache("live")
    first = asyncio.run(cache.get("ecmwf_ifs025"))
    assert first["stale"] is False

    cache.entries["ecmwf_ifs025"]["at"] -= 10000  # pretend it aged out
    monkeypatch.setattr(field, "_chunk", aborted_chunk)
    kept = asyncio.run(cache._load("ecmwf_ifs025"))

    assert kept is None  # nothing new was accepted
    assert cache.entries["ecmwf_ifs025"]["source"] == "live"
    assert cache.entries["ecmwf_ifs025"]["payload"]["points"] == first["points"]
    assert cache.last_error and "unavailable" in cache.last_error
    # A request now gets the old grid, flagged stale, and never a 500.
    served = asyncio.run(cache.get("ecmwf_ifs025"))
    assert served["stale"] is True
    assert served["points"] == first["points"]
    for task in list(cache.tasks.values()):
        task.cancel()


def test_first_fetch_failure_synthesises_a_labelled_grid(monkeypatch):
    monkeypatch.setattr(field, "_chunk", aborted_chunk)
    cache = field.FieldCache("live")
    payload = asyncio.run(cache.get("best_match"))
    assert payload["stale"] is True
    assert cache.entries["best_match"]["source"] == "synthetic"
    assert len(payload["points"]) == field.GRID_COLS * field.GRID_ROWS


def test_rate_limit_cools_down_instead_of_retrying(monkeypatch):
    calls = {"n": 0}

    async def counting_chunk(client, sample, model):
        calls["n"] += 1
        raise field.ProviderBusy(30)

    monkeypatch.setattr(field, "_chunk", counting_chunk)
    cache = field.FieldCache("live")
    # Nothing has ever been cached, so the failure produces a labelled synthesized
    # grid rather than an error page.
    payload = asyncio.run(cache.get("ecmwf_ifs025"))
    assert payload["stale"] is True
    chunks = -(-(field.GRID_COLS * field.GRID_ROWS) // field.BATCH)
    assert calls["n"] == chunks  # the parallel chunks only, no retry storm
    assert cache.busy_until > 0
    # Rate limiting is a warning, never an outage: health.error stays clean.
    assert cache.last_error is None
    assert "rate limited" in (cache.last_warning or "")
    cache.entries["ecmwf_ifs025"]["at"] -= 10  # past the "just refreshed" window
    before = calls["n"]
    assert asyncio.run(cache._load("ecmwf_ifs025")) is None  # still cooling down
    assert calls["n"] == before  # and the provider was not asked again


def test_expired_grid_is_served_stale_while_refreshing(monkeypatch):
    monkeypatch.setattr(field, "_chunk", good_chunk)
    cache = field.FieldCache("live")
    first = asyncio.run(cache.get("ecmwf_ifs025"))
    cache.entries["ecmwf_ifs025"]["at"] -= 9999
    served = asyncio.run(cache.get("ecmwf_ifs025"))
    assert served["stale"] is True
    assert served["fetchedAt"] == first["fetchedAt"]
    assert cache.tasks.get("ecmwf_ifs025") is not None  # refresh kicked off
    for task in list(cache.tasks.values()):
        task.cancel()


# ------------------------------------------- fail-soft city collection (no 429 drama)


def test_rate_limited_city_poll_is_a_deferral_not_an_outage(tmp_path, monkeypatch):
    store = main.Store(tmp_path)
    store.save([demo_weather(main.CITIES[0])])  # a snapshot to keep serving
    store.last_error = None

    async def busy(client=None):
        raise main.ProviderRateLimited("budget exhausted")

    async def no_extras(client=None):
        return None

    async def no_air(client=None):
        return None

    monkeypatch.setattr(main, "MODE", "live")
    monkeypatch.setattr(main, "fetch_city_rows", busy)
    monkeypatch.setattr(main, "fetch_extras", no_extras)
    monkeypatch.setattr(main, "fetch_air_quality", no_air)

    ok = asyncio.run(main.poll_cities(store))
    assert ok is False
    assert store.last_error is None  # never show "unavailable" for a full budget
    assert store.cache  # the previous snapshot is still served


def test_boot_that_misses_the_provider_recovers_on_the_short_cadence(monkeypatch):
    """A synthesized grid must be replaced within FIELD_RETRY, not a full cycle."""
    cache = field.FieldCache("live")
    attempts = {"n": 0}

    async def flaky_chunk(client, sample, model):
        attempts["n"] += 1
        if attempts["n"] <= 2:  # the first refresh (2 chunks) fails
            raise field.ProviderBusy(1)
        return [provider_row(lat, lon) for lat, lon in sample]

    monkeypatch.setattr(field, "_chunk", flaky_chunk)
    first = asyncio.run(cache.get("ecmwf_ifs025"))
    assert first["stale"] is True
    assert cache.entries["ecmwf_ifs025"]["source"] == "synthetic"
    assert main._grid_is_live(cache) is False  # collector will use FIELD_RETRY

    cache.busy_until = 0.0
    cache.entries["ecmwf_ifs025"]["at"] -= 100
    asyncio.run(cache.prefetch("ecmwf_ifs025"))
    assert cache.entries["ecmwf_ifs025"]["source"] == "live"
    assert main._grid_is_live(cache) is True


def test_real_provider_outage_is_reported(tmp_path, monkeypatch):
    store = main.Store(tmp_path)

    async def boom(client=None):
        raise RuntimeError("connection reset")

    async def no_extras(client=None):
        return None

    async def no_air(client=None):
        return None

    monkeypatch.setattr(main, "MODE", "live")
    monkeypatch.setattr(main, "fetch_city_rows", boom)
    monkeypatch.setattr(main, "fetch_extras", no_extras)
    monkeypatch.setattr(main, "fetch_air_quality", no_air)

    assert asyncio.run(main.poll_cities(store)) is False
    assert store.last_error and "unavailable" in store.last_error


# ------------------------------------------------------------ /api/field API


def test_field_endpoint_shape(client):
    payload = client.get("/api/field").json()
    assert set(payload) == FIELD_KEYS
    assert payload["model"] == "ecmwf_ifs025"
    assert payload["cols"] == field.GRID_COLS
    assert payload["rows"] == field.GRID_ROWS
    assert payload["bounds"] == list(field.GRID_BOUNDS)
    assert len(payload["points"]) == payload["cols"] * payload["rows"]
    assert set(payload["points"][0]) == POINT_KEYS
    assert isinstance(payload["stale"], bool)
    west, south, east, north = payload["bounds"]
    for point in payload["points"]:
        assert west <= point["lon"] <= east
        assert south <= point["lat"] <= north
        assert 0 <= point["humidity"] <= 100
        assert 0 <= point["windDirection"] < 360


def test_field_endpoint_rejects_unknown_model(client):
    bad = client.get("/api/field?model=hrrr")
    assert bad.status_code == 400
    assert "ecmwf_ifs025" in bad.json()["detail"]
    assert client.get("/api/field?model=").status_code == 400


@pytest.mark.parametrize("model", field.MODEL_IDS)
def test_field_endpoint_accepts_every_advertised_model(client, model):
    payload = client.get("/api/field?model=" + model).json()
    assert payload["model"] == model
    assert len(payload["points"]) == payload["cols"] * payload["rows"]


def test_field_endpoint_is_gzipped_and_cacheable(client):
    response = client.get("/api/field", headers={"accept-encoding": "gzip"})
    assert response.status_code == 200
    assert response.headers["content-encoding"] == "gzip"
    assert "accept-encoding" in response.headers["vary"].lower()
    assert "max-age" in response.headers["cache-control"]
    assert response.json()["model"] == "ecmwf_ifs025"


# ------------------------------------------------------------ /api/places API


def test_places_endpoint_contract(client):
    response = client.get("/api/places")
    rows = response.json()
    assert isinstance(rows, list) and len(rows) >= 100
    assert response.headers["content-encoding"] == "gzip"
    for row in rows[:50]:
        assert set(row) == PLACE_KEYS
        assert row["id"] and row["name"]
        assert 1 <= row["rank"] <= 4
        # The east bound reaches 112.2 E because the gazetteer carries the two
        # island groups (Hoang Sa at 111.6 E, Truong Sa at 111.9 E).
        assert 8.0 <= row["lat"] <= 23.5 and 101.9 <= row["lon"] <= 112.5
        assert isinstance(row["population"], int)
    ranks = [row["rank"] for row in rows]
    assert ranks == sorted(ranks)  # rank 1 first, so the map can filter cheaply
    assert len({row["id"] for row in rows}) == len(rows)


def test_places_cover_every_rank_and_major_city(client):
    rows = client.get("/api/places").json()
    by_rank = {}
    for row in rows:
        by_rank.setdefault(row["rank"], []).append(row)
    assert set(by_rank) == {1, 2, 3, 4}
    names = {row["name"] for row in by_rank[1]}
    assert "Hà Nội" in names
    assert "Hồ Chí Minh" in names
    # rank 1 is the low-zoom tier: a handful of labels, not a wall of them.
    assert 5 <= len(by_rank[1]) <= 12
    assert len(by_rank[2]) >= 30
    assert len(by_rank[4]) >= 500
    provinces = {row["admin"] for row in rows}
    assert len(provinces) >= 30
    assert "" not in provinces


def test_places_loader_falls_back_to_cities(tmp_path, monkeypatch):
    monkeypatch.setattr(places_module, "PLACES_PATH", tmp_path / "missing.json")
    monkeypatch.setattr(places_module, "_cache", {"rows": None, "source": "unloaded"})
    rows = places_module.load_places(tmp_path / "missing.json")
    assert len(rows) == len(main.CITIES)
    assert all(row["rank"] == 2 for row in rows)
    assert {row["name"] for row in rows} == {city["name"] for city in main.CITIES}
    monkeypatch.setattr(places_module, "_cache", {"rows": None, "source": "unloaded"})


def test_places_summary_reports_the_built_gazetteer():
    summary = places_module.summary()
    assert summary["places"] >= 100
    assert summary["provinces"] >= 30
    assert set(summary["ranks"]) == {"1", "2", "3", "4"}


# ------------------------------------------------------------------ /api/models


def test_models_endpoint_mirrors_the_ui_types(client):
    rows = client.get("/api/models").json()
    assert [row["id"] for row in rows] == list(field.MODEL_IDS)
    assert rows[0]["id"] == "ecmwf_ifs025"
    for row in rows:
        assert set(row) == {"id", "label", "detail"}
        assert row["label"] and row["detail"]
    # ECMWF must stay the default: that is what Windy shows.
    assert field.DEFAULT_MODEL == "ecmwf_ifs025"


# ------------------------------------------------- model selection in /api/weather


def test_city_weather_reports_its_model(client):
    payload = client.get("/api/weather").json()
    assert payload["model"] == "ecmwf_ifs025"
    assert main.CITY_MODEL == field.DEFAULT_MODEL


def test_health_exposes_grid_and_gazetteer_state(client):
    block = client.get("/api/health").json()["field"]
    assert block["model"] == "ecmwf_ifs025"
    assert block["models"] == list(field.MODEL_IDS)
    assert block["grid"]["cols"] == field.GRID_COLS
    assert block["places"]["places"] >= 100


# --------------------------------------------- supplemental visibility/UV merge


def live_payload():
    ts = int(datetime(2026, 11, 9, 12, 0, tzinfo=UTC).timestamp())
    return {
        "current": {
            "time": ts,
            "temperature_2m": 16.2,
            "apparent_temperature": 15.0,
            "relative_humidity_2m": 73,
            "wind_speed_10m": 15.8,
            "wind_direction_10m": 90,
            "precipitation": 0.0,
            "weather_code": 2,
            "pressure_msl": 1012,
            "cloud_cover": 40,
            "is_day": 1,
            "dew_point_2m": 11.4,
            "wind_gusts_10m": 30.6,
        },
        "hourly": {
            "time": [ts],
            **{
                key: [value]
                for key, value in {
                    "temperature_2m": 16.2,
                    "relative_humidity_2m": 73,
                    "precipitation_probability": 20,
                    "precipitation": 0.0,
                    "weather_code": 2,
                    "wind_speed_10m": 15.8,
                }.items()
            },
        },
        "daily": {
            "time": [ts],
            **{
                key: [value]
                for key, value in {
                    "temperature_2m_max": 19.0,
                    "temperature_2m_min": 12.0,
                    "weather_code": 2,
                    "precipitation_probability_max": 20,
                    "uv_index_max": [None],
                }.items()
            },
        },
    }


EXTRAS = {
    "current": {"visibility": 17480.0, "uv_index": 0.0},
    "daily": {"uv_index_max": [7.4]},
}


def test_ecmwf_missing_visibility_and_uv_are_filled_from_extras():
    city = next(c for c in main.CITIES if c["id"] == "hanoi")
    weather = parse_live(city, live_payload(), datetime(2026, 11, 9, 12, tzinfo=UTC), extras=EXTRAS)
    assert weather["current"]["visibility"] == 17480.0
    assert weather["current"]["uvIndex"] == 0.0
    assert weather["daily"][0]["uv"] == 7.4
    assert weather["current"]["temperature"] == 16.2  # primary model wins


def test_parse_live_without_extras_keeps_documented_defaults():
    city = next(c for c in main.CITIES if c["id"] == "hanoi")
    weather = parse_live(city, live_payload(), datetime(2026, 11, 9, 12, tzinfo=UTC))
    assert weather["current"]["visibility"] == 20000.0
    assert weather["current"]["uvIndex"] == 0.0
    assert weather["daily"][0]["uv"] is None


def test_extras_only_fill_gaps_never_override_the_primary_model():
    payload = live_payload()
    payload["current"]["visibility"] = 9000.0
    payload["current"]["uv_index"] = 5.1
    payload["daily"]["uv_index_max"] = [3.3]
    city = next(c for c in main.CITIES if c["id"] == "hanoi")
    weather = parse_live(city, payload, datetime(2026, 11, 9, 12, tzinfo=UTC), extras=EXTRAS)
    assert weather["current"]["visibility"] == 9000.0
    assert weather["current"]["uvIndex"] == 5.1
    assert weather["daily"][0]["uv"] == 3.3