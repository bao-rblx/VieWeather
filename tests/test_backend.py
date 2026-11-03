import json
from datetime import datetime, timezone, timedelta
import pytest
from fastapi.testclient import TestClient
from backend import main
from backend.weather import demo_weather, observation, parse_live


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DATA", tmp_path)
    monkeypatch.setattr(main, "MODE", "demo")
    with TestClient(main.app) as c:
        yield c


def test_demo_forecast_has_correct_timeline_and_source():
    now = datetime(2026, 11, 1, 18, 30, tzinfo=timezone.utc)
    w = demo_weather(main.CITIES[0], now)
    assert w["source"] == "demo"
    assert len(w["hourly"]) == 168
    assert w["daily"][0]["date"] == "2026-11-02"
    assert w["hourly"][0]["time"] == "2026-11-01T18:00:00Z"
    assert all(0 <= h["rainProbability"] <= 100 for h in w["hourly"])


def test_deduplication_and_atomic_event_files(tmp_path):
    s = main.Store(tmp_path)
    w = demo_weather(main.CITIES[0])
    s.save([w])
    s.save([w])
    with s.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM observations").fetchone()[0] == 1
    files = list((tmp_path / "incoming").glob("*.json"))
    assert len(files) == 1
    assert json.loads(files[0].read_text())["event_id"] == observation(w)["event_id"]
    assert not list((tmp_path / "incoming").glob("*.tmp"))
    assert main.Store(tmp_path).cache["hanoi"]["source"] == "demo"


def test_stale_cache_is_labeled(tmp_path):
    s = main.Store(tmp_path)
    s.save(
        [demo_weather(main.CITIES[0], datetime.now(timezone.utc) - timedelta(hours=1))]
    )
    assert s.snapshot()[0]["stale"] is True


def test_api_endpoints_and_export(client):
    payload = client.get("/api/weather").json()
    # one row per configured location (25 mainland cities plus the two island groups)
    assert len(payload["cities"]) == len(main.CITIES)
    assert all(w["source"] == "demo" for w in payload["cities"])
    assert client.get("/api/health").json()["status"] == "ok"
    analytics = client.get("/api/analytics").json()
    assert analytics["spark"]["status"] == "not connected"
    assert analytics["counts"][0]["events"] >= 25
    assert client.get("/api/history/hanoi?source=demo").json()
    assert client.get("/api/history/hanoi?source=open-meteo").json() == []
    assert client.get("/api/history/missing").status_code == 404
    assert client.get("/api/history/hanoi?hours=999").status_code == 422
    assert client.get("/api/history/hanoi?source=bad").status_code == 422
    csv = client.get("/api/export")
    assert "event_id,city_id" in csv.text
    assert "attachment" in csv.headers["content-disposition"]


def test_spark_output_is_read_and_bad_file_handled(client):
    folder = main.DATA / "gold"
    folder.mkdir()
    path = folder / "batch-000000000001.json"
    path.write_text(
        json.dumps({"batchId": 1, "processedAt": "2026-11-01T00:00:00Z", "windows": []})
    )
    assert client.get("/api/analytics").json()["spark"]["status"] == "recent output"
    path.write_text("broken")
    assert (
        client.get("/api/analytics").json()["spark"]["status"] == "output unavailable"
    )


def test_spark_heartbeat_controls_connection_status(client):
    status = main.DATA / "spark-status.json"
    status.write_text(
        json.dumps(
            {
                "updatedAt": "2026-11-01T00:00:00Z",
                "queries": [{"active": True, "name": "bronze"}],
            }
        )
    )
    assert client.get("/api/analytics").json()["spark"]["status"] == "active"
    import os
    import time

    os.utime(status, (time.time() - 60, time.time() - 60))
    assert client.get("/api/analytics").json()["spark"]["status"] == "disconnected"


def test_live_adapter_preserves_provider_time():
    now = datetime(2026, 11, 1, 12, tzinfo=timezone.utc)
    ts = int(now.timestamp())
    data = {
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
            is_day=0,
        ),
        "hourly": {
            "time": [ts],
            **{
                k: [v]
                for k, v in {
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
                k: [v]
                for k, v in {
                    "temperature_2m_max": 30,
                    "temperature_2m_min": 24,
                    "weather_code": 2,
                    "precipitation_probability_max": 30,
                    "uv_index_max": 7,
                }.items()
            },
        },
    }
    w = parse_live(main.CITIES[0], data, now)
    assert w["observedAt"] == "2026-11-01T12:00:00Z"
    assert w["source"] == "open-meteo"
    assert w["current"]["isDay"] is False
