"""Feature tests for air quality, sun/moon, alerts and ranked city search."""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.weather import (
    aqi_category,
    build_alerts,
    demo_air_quality,
    demo_alerts,
    demo_weather,
    moon_times,
    normalize_text,
    parse_air_quality,
    parse_live,
    pm25_subindex,
    search_cities,
    sun_times,
)

UTC = timezone.utc
WHEN = datetime(2026, 11, 9, 12, 0, tzinfo=UTC)
BY_ID = {c["id"]: c for c in main.CITIES}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DATA", tmp_path)
    monkeypatch.setattr(main, "MODE", "demo")
    with TestClient(main.app) as c:
        yield c


def parse(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def live_payload():
    """Minimal Open-Meteo forecast response for one city, as parse_live expects."""
    ts = int(WHEN.timestamp())
    return {
        "current": dict(
            time=ts,
            temperature_2m=27,
            apparent_temperature=29,
            relative_humidity_2m=80,
            wind_speed_10m=12,
            wind_direction_10m=90,
            precipitation=0,
            weather_code=2,
            pressure_msl=1010,
            cloud_cover=50,
            is_day=1,
        ),
        "hourly": {
            "time": [ts],
            **{
                key: [value]
                for key, value in {
                    "temperature_2m": 27,
                    "relative_humidity_2m": 80,
                    "precipitation_probability": 30,
                    "precipitation": 0,
                    "weather_code": 2,
                    "wind_speed_10m": 12,
                }.items()
            },
        },
        "daily": {
            "time": [ts],
            **{
                key: [value]
                for key, value in {
                    "temperature_2m_max": 30,
                    "temperature_2m_min": 24,
                    "weather_code": 2,
                    "precipitation_probability_max": 30,
                    "uv_index_max": 7,
                }.items()
            },
        },
    }


# ---------------------------------------------------------------------------
# Sun and moon
# ---------------------------------------------------------------------------

# Independent ground truth from the Open-Meteo daily endpoint for the Vietnamese
# local date 2026-11-09, used to prove the NOAA implementation is correct.
SUN_TRUTH = {
    "hanoi": ("2026-11-08T23:03:10Z", "2026-11-09T10:17:07Z"),
    "hue": ("2026-11-08T22:50:24Z", "2026-11-09T10:16:33Z"),
    "da-lat": ("2026-11-08T22:40:56Z", "2026-11-09T10:18:46Z"),
    "hcmc": ("2026-11-08T22:46:57Z", "2026-11-09T10:27:35Z"),
}


@pytest.mark.parametrize("city_id", sorted(SUN_TRUTH))
def test_sun_times_match_provider_within_three_minutes(city_id):
    sunrise, sunset = SUN_TRUTH[city_id]
    city = BY_ID[city_id]
    block = sun_times(city["lat"], city["lon"], WHEN)
    assert abs((parse(block["sunrise"]) - parse(sunrise)).total_seconds()) < 180
    assert abs((parse(block["sunset"]) - parse(sunset)).total_seconds()) < 180


def test_sun_block_is_ordered_and_consistent():
    city = BY_ID["da-nang"]
    block = sun_times(city["lat"], city["lon"], WHEN)
    assert set(block) == {
        "sunrise",
        "sunset",
        "dawn",
        "dusk",
        "solarNoon",
        "dayLength",
    }
    assert all(block[key].endswith("Z") for key in block if key != "dayLength")
    assert parse(block["dawn"]) < parse(block["sunrise"])
    assert parse(block["sunrise"]) < parse(block["solarNoon"]) < parse(block["sunset"])
    assert parse(block["sunset"]) < parse(block["dusk"])
    assert (
        block["dayLength"]
        == (parse(block["sunset"]) - parse(block["sunrise"])).total_seconds()
    )
    assert 10 * 3600 < block["dayLength"] < 13 * 3600


def test_moon_block_matches_phase_geometry():
    city = BY_ID["hanoi"]
    block = moon_times(city["lat"], city["lon"], WHEN)
    assert set(block) == {"phase", "illumination", "rise", "set", "name"}
    assert 0 <= block["phase"] < 1
    expected = round(
        (1 - __import__("math").cos(2 * 3.141592653589793 * block["phase"])) / 2 * 100
    )
    assert block["illumination"] == expected
    assert 0 <= block["illumination"] <= 100
    assert parse(block["rise"]) < parse(block["set"])
    # Around the new moon of November 2026 the disc must be almost unlit.
    assert block["illumination"] <= 6
    assert block["name"] == "New moon"


def test_moon_phase_advances_one_synodic_month():
    city = BY_ID["hue"]
    first = moon_times(city["lat"], city["lon"], WHEN)["phase"]
    later = moon_times(city["lat"], city["lon"], WHEN + timedelta(days=1))["phase"]
    step = (later - first) % 1.0
    assert 0.030 < step < 0.038  # 1 / 29.53 days
    full = moon_times(city["lat"], city["lon"], WHEN + timedelta(days=15))
    assert full["name"] == "Full moon"
    assert full["illumination"] >= 95


# ---------------------------------------------------------------------------
# Air quality
# ---------------------------------------------------------------------------


def test_pm25_subindex_breakpoints():
    assert pm25_subindex(0) == 0
    assert pm25_subindex(12.0) == 50
    assert pm25_subindex(35.4) == 100
    assert pm25_subindex(55.4) == 150
    assert pm25_subindex(150.4) == 200
    assert pm25_subindex(250.4) == 300
    assert pm25_subindex(500.4) == 500
    assert pm25_subindex(900) == 500
    assert pm25_subindex(24) == 76


def test_aqi_category_bands():
    assert aqi_category(0) == "Good"
    assert aqi_category(50) == "Good"
    assert aqi_category(51) == "Moderate"
    assert aqi_category(100) == "Moderate"
    assert aqi_category(101) == "Unhealthy (sensitive)"
    assert aqi_category(151) == "Unhealthy"
    assert aqi_category(201) == "Very unhealthy"
    assert aqi_category(301) == "Hazardous"


def test_parse_air_quality_from_provider_row():
    row = {
        "current": {
            "time": "2026-11-09T18:00",
            "european_aqi": 37,
            "pm2_5": 13.5,
            "pm10": 15.1,
            "ozone": 65.0,
            "nitrogen_dioxide": 9.8,
            "sulphur_dioxide": 8.9,
            "carbon_monoxide": 451.0,
            "us_aqi": 52,
        }
    }
    block = parse_air_quality(row)
    assert block == {
        "aqi": 52,
        "pm25": 13.5,
        "pm10": 15.1,
        "ozone": 65.0,
        "no2": 9.8,
        "so2": 8.9,
        "co": 451.0,
        "category": "Moderate",
    }
    assert parse_air_quality({}) is None
    assert parse_air_quality({"current": {"pm10": 20}}) is None
    # Without us_aqi the index falls back to the PM2.5 breakpoints.
    assert parse_air_quality({"current": {"pm2_5": 24.0}})["aqi"] == pm25_subindex(24.0)


def test_demo_air_quality_is_deterministic_and_plausible():
    hanoi = BY_ID["hanoi"]
    first = demo_air_quality(hanoi, WHEN)
    second = demo_air_quality(hanoi, WHEN)
    assert first == second
    assert set(first) == {
        "aqi",
        "pm25",
        "pm10",
        "ozone",
        "no2",
        "so2",
        "co",
        "category",
    }
    assert first["category"] == aqi_category(first["aqi"])
    for city in main.CITIES:
        block = demo_air_quality(city, WHEN)
        assert 0 <= block["aqi"] <= 500
        assert 0 < block["pm25"] < block["pm10"]
        assert block["category"] == aqi_category(block["aqi"])
    # The northern dry season is dirtier than the highlands.
    assert demo_air_quality(hanoi, WHEN)["aqi"] > demo_air_quality(
        BY_ID["da-lat"], WHEN
    )["aqi"]


# ---------------------------------------------------------------------------
# Live adapter
# ---------------------------------------------------------------------------


def test_parse_live_merges_air_quality_block_and_row():
    city = BY_ID["hanoi"]
    row = {"current": {"pm2_5": 30.0, "pm10": 40.0, "us_aqi": 95}}
    from_row = parse_live(city, live_payload(), WHEN, air=row)
    assert from_row["airQuality"]["aqi"] == 95
    block = parse_air_quality(row)
    from_block = parse_live(city, live_payload(), WHEN, air=block)
    assert from_block["airQuality"] == block
    assert from_block["alerts"] == [] or isinstance(from_block["alerts"], list)
    # No reading at all still yields a complete payload without airQuality data.
    assert parse_live(city, live_payload(), WHEN)["airQuality"] is None


def test_parse_live_adds_feature_blocks_and_defaults():
    city = BY_ID["hue"]
    weather = parse_live(city, live_payload(), WHEN)
    current = weather["current"]
    assert current["dewPoint"] == 23.4 or 22 < current["dewPoint"] < 25
    assert current["visibility"] == 20000.0
    assert current["uvIndex"] == 0.0
    assert current["windGust"] == 18.0
    assert set(weather["sun"]) == {
        "sunrise",
        "sunset",
        "dawn",
        "dusk",
        "solarNoon",
        "dayLength",
    }
    assert weather["moon"]["name"]
    assert weather["daily"][0]["sunrise"].endswith("Z")
    assert weather["daily"][0]["sunset"].endswith("Z")
    assert weather["daily"][0]["windMax"] is None
    assert weather["daily"][0]["precipitationSum"] is None


# ---------------------------------------------------------------------------
# Alerts
# ---------------------------------------------------------------------------


def calm_current():
    return {
        "temperature": 27.0,
        "wind": 8.0,
        "windGust": 14.0,
        "visibility": 18000.0,
    }


def test_build_alerts_is_quiet_in_calm_conditions():
    assert build_alerts(BY_ID["hue"], calm_current(), [{}], None, WHEN) == []


def test_build_alerts_derives_each_hazard():
    city = BY_ID["da-nang"]
    rainy = build_alerts(city, calm_current(), [{"precipitationSum": 62.0}], None, WHEN)
    assert [(a["severity"], a["title"]) for a in rainy] == [
        ("warning", "Heavy rain warning")
    ]
    flooding = build_alerts(city, calm_current(), [{"precipitationSum": 130.0}], None, WHEN)
    assert flooding[0]["severity"] == "severe"

    gusty = build_alerts(city, {**calm_current(), "windGust": 47.0}, [{}], None, WHEN)
    assert gusty[0]["title"] == "Wind advisory"
    storm = build_alerts(city, {**calm_current(), "windGust": 72.0}, [{}], None, WHEN)
    assert storm[0]["severity"] == "warning"

    foggy = build_alerts(city, {**calm_current(), "visibility": 400.0}, [{}], None, WHEN)
    assert foggy[0]["title"] == "Dense fog advisory"

    dirty = build_alerts(city, calm_current(), [{}], {"aqi": 165}, WHEN)
    assert dirty[0]["title"] == "Air quality alert"
    assert dirty[0]["severity"] == "watch"

    hot = build_alerts(city, {**calm_current(), "temperature": 39.2}, [{}], None, WHEN)
    assert hot[0]["title"] == "Extreme heat warning"


def test_build_alerts_orders_by_severity_and_is_stable():
    city = BY_ID["dong-hoi"]
    current = {**calm_current(), "windGust": 50.0, "visibility": 300.0}
    alerts = build_alerts(city, current, [{"precipitationSum": 120.0}], {"aqi": 210}, WHEN)
    severities = [a["severity"] for a in alerts]
    assert severities[0] == "severe"
    assert severities == sorted(
        severities, key=lambda s: -{"info": 0, "watch": 1, "warning": 2, "severe": 3}[s]
    )
    for alert in alerts:
        assert set(alert) == {
            "id",
            "severity",
            "title",
            "body",
            "region",
            "starts",
            "ends",
        }
        assert alert["region"] == city["region"]
        assert parse(alert["starts"]) < parse(alert["ends"])
    again = build_alerts(city, current, [{"precipitationSum": 120.0}], {"aqi": 210}, WHEN)
    assert [a["id"] for a in again] == [a["id"] for a in alerts]


def test_demo_alerts_are_deterministic_and_sparse():
    with_alerts = [c for c in main.CITIES if demo_alerts(c, WHEN)]
    assert 4 <= len(with_alerts) <= 10
    assert "hanoi" in {c["id"] for c in with_alerts}
    assert "da-nang" in {c["id"] for c in with_alerts}
    hanoi = demo_alerts(BY_ID["hanoi"], WHEN)
    assert hanoi == demo_alerts(BY_ID["hanoi"], WHEN + timedelta(minutes=30))
    assert demo_alerts(BY_ID["hanoi"], WHEN + timedelta(days=1))[0]["id"] != (
        hanoi[0]["id"]
    )
    for alert in hanoi:
        assert alert["severity"] in {"info", "watch", "warning", "severe"}
        assert alert["title"] and alert["body"]


# ---------------------------------------------------------------------------
# Demo payload
# ---------------------------------------------------------------------------


def test_demo_weather_carries_every_feature_block():
    weather = demo_weather(BY_ID["hanoi"], WHEN)
    assert set(weather) >= {
        "city",
        "source",
        "observedAt",
        "fetchedAt",
        "current",
        "hourly",
        "daily",
        "airQuality",
        "sun",
        "moon",
        "alerts",
    }
    current = weather["current"]
    for key in ("uvIndex", "dewPoint", "visibility", "windGust"):
        assert isinstance(current[key], (int, float))
    assert 0 <= current["uvIndex"] <= 12
    assert current["dewPoint"] < current["temperature"]
    assert weather["airQuality"]["category"] == aqi_category(weather["airQuality"]["aqi"])
    assert 0 < weather["sun"]["dayLength"] < 86400
    assert 0 <= weather["moon"]["phase"] < 1
    assert len(weather["daily"]) == 7
    for day in weather["daily"]:
        assert day["sunrise"].endswith("Z") and day["sunset"].endswith("Z")
        assert day["windMax"] >= 0
        assert day["precipitationSum"] >= 0
    # The demo adapter must stay byte-identical for a fixed clock.
    assert demo_weather(BY_ID["hanoi"], WHEN) == weather


# ---------------------------------------------------------------------------
# City search
# ---------------------------------------------------------------------------


def test_normalize_text_folds_vietnamese_diacritics():
    assert normalize_text("Hu\u1ebf") == "hue"
    assert normalize_text("\u0110\u00e0 N\u1eb5ng") == "da nang"
    assert normalize_text("  HA   NOI ") == "ha noi"


def test_search_ranks_prefix_before_substring():
    names = [c["name"] for c in search_cities(main.CITIES, "ho")]
    assert names[0] == "Ho Chi Minh City"
    assert "Thanh Hoa" in names
    assert names.index("Ho Chi Minh City") < names.index("Thanh Hoa")
    assert search_cities(main.CITIES, "da nang")[0]["name"] == "Da Nang"
    assert search_cities(main.CITIES, "dalat")[0]["id"] == "da-lat"
    assert search_cities(main.CITIES, "Hue")[0]["id"] == "hue"


def test_search_accepts_accents_initials_and_limits():
    assert search_cities(main.CITIES, "Hu\u1ebf")[0]["id"] == "hue"
    assert search_cities(main.CITIES, "\u0110\u00e0 N\u1eb5ng")[0]["id"] == "da-nang"
    assert search_cities(main.CITIES, "dn")[0]["id"] == "da-nang"
    assert search_cities(main.CITIES, "hcmc")[0]["id"] == "hcmc"
    assert len(search_cities(main.CITIES, "", 5)) == 5
    assert len(search_cities(main.CITIES, "a", 3)) == 3
    assert len(search_cities(main.CITIES, "a", 25)) <= 25
    assert search_cities(main.CITIES, "zzzz") == []
    assert set(search_cities(main.CITIES, "hue")[0]) == {
        "id",
        "name",
        "region",
        "lat",
        "lon",
    }


# ---------------------------------------------------------------------------
# API surface
# ---------------------------------------------------------------------------


def test_weather_payload_exposes_feature_blocks(client):
    payload = client.get("/api/weather").json()
    assert len(payload["cities"]) == len(main.CITIES)
    for weather in payload["cities"]:
        assert weather["airQuality"]["aqi"] >= 0
        assert weather["sun"]["dayLength"] > 0
        assert 0 <= weather["moon"]["phase"] < 1
        assert isinstance(weather["alerts"], list)
        assert weather["stale"] is False


def test_air_quality_endpoint(client):
    block = client.get("/api/air-quality/hanoi").json()
    assert set(block) == {
        "aqi",
        "pm25",
        "pm10",
        "ozone",
        "no2",
        "so2",
        "co",
        "category",
    }
    assert client.get("/api/air-quality/atlantis").status_code == 404


def test_city_search_endpoint(client):
    hits = client.get("/api/cities/search?q=h&limit=3").json()
    assert isinstance(hits, list) and len(hits) == 3
    assert set(hits[0]) == {"id", "name", "region", "lat", "lon"}
    assert client.get("/api/cities/search?q=hue").json()[0]["id"] == "hue"
    assert client.get("/api/cities/search?q=da&limit=9").json()[0]["id"] == "da-lat"
    assert len(client.get("/api/cities/search").json()) == 8
    assert client.get("/api/cities/search?limit=0").status_code == 422


def test_alerts_endpoint_flattens_cities(client):
    items = client.get("/api/alerts").json()
    assert items, "demo mode should carry a few alerts"
    for item in items:
        assert set(item) == {
            "id",
            "severity",
            "title",
            "body",
            "region",
            "starts",
            "ends",
            "city_id",
            "city_name",
        }
        assert item["city_id"] in BY_ID
        assert item["city_name"] == BY_ID[item["city_id"]]["name"]
    ranks = [-{"info": 0, "watch": 1, "warning": 2, "severe": 3}[i["severity"]] for i in items]
    assert ranks == sorted(ranks)


def test_existing_endpoints_stay_compatible(client):
    assert client.get("/api/health").json()["status"] == "ok"
    analytics = client.get("/api/analytics").json()
    assert analytics["counts"][0]["events"] >= 25
    assert client.get("/api/history/hanoi?source=demo").json()
    assert "event_id,city_id" in client.get("/api/export").text
    payload = client.get("/api/weather").json()
    # "model" is additive: the UI shows which forecast the city numbers come from.
    assert set(payload) == {"cities", "sequence", "providerError", "mode", "model"}
    assert payload["model"] == main.CITY_MODEL == "ecmwf_ifs025"
    first = payload["cities"][0]
    assert set(first) >= {
        "city",
        "source",
        "observedAt",
        "fetchedAt",
        "stale",
        "current",
        "hourly",
        "daily",
    }
    assert set(first["current"]) >= {
        "temperature",
        "feelsLike",
        "humidity",
        "wind",
        "windDirection",
        "precipitation",
        "code",
        "pressure",
        "cloudCover",
        "isDay",
    }
