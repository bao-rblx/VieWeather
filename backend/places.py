"""Vietnam place gazetteer served by GET /api/places.

The map draws a temperature next to every place name, so the payload is a plain
array of Place objects (no wrapper) that the client turns into GeoJSON once:

    { "id": "ha-noi-1581130", "name": "Hà Nội", "lat": 21.0245, "lon": 105.84117,
      "rank": 1, "admin": "Hà Nội", "population": 8053663 }

rank drives label density by zoom:
    1  major city (7)          2  province capital (~46)
    3  district town (~630)    4  commune / ward seat (~6000, deterministic sample)

The data comes from scripts/build_places.py (GeoNames VN dump, no API key). If the
built file is missing the endpoint still answers with the 25 monitored cities, so
the map never loses its labels.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

log = logging.getLogger("vieweather.places")

PLACES_PATH = Path(__file__).with_name("places.json")
ROOT = Path(__file__).resolve().parents[1]
CITIES_PATH = ROOT / "backend" / "cities.json"
MAX_RANK = 4
KEYS = ("id", "name", "lat", "lon", "rank", "admin", "population")

_cache = {"rows": None, "source": "unloaded"}


def _slug(value):
    text = "".join(ch if ch.isalnum() else "-" for ch in str(value).lower())
    while "--" in text:
        text = text.replace("--", "-")
    return text.strip("-") or "place"


def _clean(row):
    """Keep exactly the Place fields, with stable types."""
    return {
        "id": str(row["id"]),
        "name": str(row["name"]),
        "lat": round(float(row["lat"]), 5),
        "lon": round(float(row["lon"]), 5),
        "rank": max(1, min(MAX_RANK, int(row["rank"]))),
        "admin": str(row.get("admin") or ""),
        "population": int(row.get("population") or 0),
    }


def load_places(path=None):
    """Load (and cache) the built gazetteer, sorted rank then population."""
    global _cache
    if _cache["rows"] is not None and path is None:
        return _cache["rows"]
    target = Path(path) if path is not None else PLACES_PATH
    try:
        rows = json.loads(target.read_text(encoding="utf-8"))
        places = [_clean(row) for row in rows if row.get("name")]
        places.sort(key=lambda p: (p["rank"], -p["population"], p["name"]))
        _cache = {"rows": places, "source": str(target.name)}
        log.info("Loaded %s places from %s", len(places), target)
        return places
    except (OSError, ValueError, KeyError, TypeError) as exc:
        log.warning("Gazetteer %s unavailable (%s); using monitored cities", target, exc)
        places = fallback_places()
        _cache = {"rows": places, "source": "cities.json"}
        return places


def fallback_places():
    """The monitored locations as rank 2 places, so /api/places always answers."""
    try:
        cities = json.loads(CITIES_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    rows = []
    for city in cities:
        name = city.get("name") or city["id"]
        rows.append(
            {
                "id": _slug(city["id"]),
                "name": name,
                "lat": round(float(city["lat"]), 5),
                "lon": round(float(city["lon"]), 5),
                "rank": 2,
                "admin": str(city.get("region") or ""),
                "population": 0,
            }
        )
    rows.sort(key=lambda p: (p["rank"], p["name"]))
    return rows


def summary():
    rows = load_places()
    counts = {}
    for row in rows:
        counts[row["rank"]] = counts.get(row["rank"], 0) + 1
    return {
        "places": len(rows),
        "source": _cache["source"],
        "ranks": {str(rank): counts.get(rank, 0) for rank in range(1, MAX_RANK + 1)},
        "provinces": len({row["admin"] for row in rows if row["admin"]}),
    }
