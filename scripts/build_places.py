#!/usr/bin/env python
"""Build the Vietnam place gazetteer served by GET /api/places.

Source: GeoNames country dump VN.zip (no API key). The dump has 67k records:
  * class P (populated places, 41.9k) - PPLC/PPLA/PPLA2 are administrative seats,
    plain PPL are villages/wards with mostly missing population.
  * class A (administrative divisions) - ADM1 (province, 34 after the 2025 merger),
    ADM2 (district), ADM3 (commune/ward seat, 10.5k) with real coordinates.

The map needs four label tiers that appear progressively as the user zooms in:

  rank 1  major city            population >= 1,000,000 or PPLC          (~7)
  rank 2  province capital      remaining PPLA records                    (~46)
  rank 3  district town         PPLA2/PPLA3/PPLX + large PPL              (~630)
  rank 4  commune / ward seat   deterministic sample of ADM3             (~4500)

Rank 4 is hash-sampled (stable across runs) instead of shipping all 10.5k
communes, which keeps the payload near 120 kB gzipped while still putting a real
place name under the cursor at every zoom level where basemap labels thin out.

Names: GeoNames labels Hanoi as "Hanoi" and writes an Eth for Vietnamese "D with
a stroke". The display name is taken from the alternatenames column whenever a
more Vietnamese spelling of the same place exists ("Ha Noi" -> "Ha Noi" with
tone marks), so the weather label next to the vector basemap's name:vi agrees.

Usage:
    python scripts/build_places.py                 # uses %TEMP%\gn\VN.txt
    python scripts/build_places.py --limit 3000    # smaller rank-4 sample
    python scripts/build_places.py --input VN.txt --output backend/places.json
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sys
import unicodedata
import zipfile
from collections import Counter
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
OUT_DEFAULT = ROOT / "backend" / "places.json"
DUMP_URL = "https://download.geonames.org/export/dump/VN.zip"
ADMIN1_URL = "https://download.geonames.org/export/dump/admin1CodesASCII.txt"

# Column indices of the GeoNames "geoname" table (tab separated).
GID, NAME, ASCII, ALTERNATES, LAT, LON, CLS, CODE = range(8)
ADM1_CODE, ADM2_CODE, ADM3_CODE, POP = 10, 11, 12, 14

MUNICIPAL_POP = 1_000_000  # the six centrally governed cities (plus Bien Hoa)
DISTRICT_POP = 50_000
SAMPLE_STEP = 0.025  # degrees; keeps rank-4 labels from stacking on one tile
NEAR_KM = 2.0  # a place this close to a better-ranked one is a duplicate
# Province codes of the six centrally governed municipalities. GeoNames labels the
# province (ADM1) in English ("Hanoi", "Ho Chi Minh City"), so the Vietnamese name
# of that province's own capital is used instead.
MUNICIPALITY_CODES = ("01", "31", "48", "46", "92", "79")
JUNK_NAMES = {"south east asia", "vietnam", "viet nam", "indochina", "asia"}

# GeoNames writes an Eth wherever Vietnamese has a D with a stroke.
ETH = str.maketrans({"\u00d0": "\u0110", "\u00f0": "\u0111"})

# Leading administrative words, matched as whole folded words.
UNIT_WORDS = {
    ("xa",),
    ("phuong",),
    ("quan",),
    ("tinh",),
    ("tp",),
    ("thi", "tran"),
    ("thi", "xa"),
    ("thanh", "pho"),
}
PROVINCE_SUFFIXES = (" province", " city", " (hcmc)", " municipality", " commune")
COMPARE_STRIP = (" thanh pho", " city", " tinh", " province")


def tidy(value: str) -> str:
    return " ".join(str(value).translate(ETH).split())


def deaccent(value: str) -> str:
    folded = unicodedata.normalize("NFD", value.replace("\u0111", "d").replace("\u0110", "D"))
    return "".join(ch for ch in folded if not unicodedata.combining(ch))


def normalise(value: str) -> str:
    return " ".join(deaccent(tidy(value)).lower().split())


def compact(value: str) -> str:
    """Diacritic- and space-free key used to decide two names are the same place."""
    key = normalise(value).replace(" ", "")
    for suffix in COMPARE_STRIP:
        tail = suffix.replace(" ", "")
        if key.endswith(tail):
            key = key[: -len(tail)]
    return key.replace("y", "i")


def exact_key(value: str) -> str:
    return normalise(value).replace(" ", "")


def diacritics(value: str) -> int:
    return sum(1 for ch in value if ord(ch) > 127)


def strip_unit(text: str) -> str:
    """Strip leading administrative words by whole words ("Xa", "Thanh pho").

    Word based on purpose: a raw prefix match would cut "Quang Ngai" down to
    "Ngai", because "quang ngai" starts with "quan".
    """
    words = text.split()
    folded = [normalise(word).rstrip(".") for word in words]
    for size in (2, 1):
        if len(words) > size and tuple(folded[:size]) in UNIT_WORDS:
            return " ".join(words[size:])
    return text


def strip_type_suffixes(text: str) -> str:
    for suffix in PROVINCE_SUFFIXES:
        if text.lower().endswith(suffix):
            text = text[: -len(suffix)]
    return text


def clean_province(name: str) -> str:
    return strip_unit(strip_type_suffixes(tidy(name)))


def clean_place(name: str) -> str:
    text = strip_unit(strip_type_suffixes(tidy(name)))
    return text or tidy(name)


def vietnamese_name(name: str, alternates) -> str:
    """Prefer the most Vietnamese spelling of a place among its aliases.

    "Hanoi" has the alias "Ha Noi" with tone marks; "Hai Phong" has "Hai Phong"
    (same shape, three diacritics). Only aliases that collapse to the same key are
    considered, so unrelated translations are ignored.
    """
    best, best_diacritics = name, diacritics(name)
    if best_diacritics >= 2:
        return best
    base = compact(name)
    base_exact = exact_key(name)
    for alias in alternates:
        candidate = clean_place(alias)
        if not candidate or len(candidate) > 48:
            continue
        if diacritics(candidate) <= best_diacritics:
            continue
        if compact(candidate) != base:
            continue
        if diacritics(candidate) == best_diacritics and exact_key(candidate) != base_exact:
            continue
        best, best_diacritics = candidate, diacritics(candidate)
    return best


def slug(value: str) -> str:
    collapsed = "".join(ch if ch.isalnum() else "-" for ch in deaccent(value).lower())
    while "--" in collapsed:
        collapsed = collapsed.replace("--", "-")
    return collapsed.strip("-") or "place"


def haversine_km(lat1, lon1, lat2, lon2) -> float:
    from math import asin, cos, radians, sin, sqrt

    dlat, dlon = radians(lat2 - lat1), radians(lon2 - lon1)
    h = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return 2 * 6371.0 * asin(min(1.0, sqrt(h)))


# --------------------------------------------------------------- data sources


def read_records(path: Path):
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            fields = line.rstrip("\n").split("\t")
            if len(fields) >= 19:
                rows.append(fields)
    return rows


def ensure_vn_txt(explicit):
    if explicit:
        path = Path(explicit)
        if not path.exists():
            raise SystemExit("input not found: " + str(path))
        return path
    cached = Path(os.environ.get("TEMP", "/tmp")) / "gn" / "VN.txt"
    if cached.exists():
        return cached
    cached.parent.mkdir(parents=True, exist_ok=True)
    archive = cached.parent / "VN.zip"
    print("downloading " + DUMP_URL + " -> " + str(archive))
    archive.write_bytes(urlopen(DUMP_URL, timeout=180).read())
    with zipfile.ZipFile(archive) as bundle:
        bundle.extract("VN.txt", cached.parent)
    return cached


def ensure_admin1():
    """GeoNames admin1 reference table: VN.<code> -> province label."""
    cached = Path(os.environ.get("TEMP", "/tmp")) / "gn" / "admin1CodesASCII.txt"
    if not cached.exists():
        cached.parent.mkdir(parents=True, exist_ok=True)
        print("downloading " + ADMIN1_URL + " -> " + str(cached))
        cached.write_bytes(urlopen(ADMIN1_URL, timeout=120).read())
    table = {}
    for line in cached.read_text(encoding="utf-8").splitlines():
        fields = line.split("\t")
        if len(fields) >= 2 and fields[0].startswith("VN."):
            table[fields[0][3:]] = fields[1]
    return table


# --------------------------------------------------------------- gazetteer


def province_names(records, admin1):
    """Numeric admin1 code -> Vietnamese province name with diacritics.

    The reference file is partly ASCII ("Tuyen Quang"), so each entry is matched
    against the ADM1/ADM1H records of the dump, which carry the accented spelling;
    the most accented spelling wins.
    """
    accents = {}
    for row in records:
        if row[CODE] in ("ADM1", "ADM1H"):
            cleaned = clean_province(row[NAME])
            key = normalise(cleaned)
            if key and (key not in accents or diacritics(cleaned) > diacritics(accents[key])):
                accents[key] = cleaned
    table = {}
    unresolved = []
    for code, label in admin1.items():
        wanted = clean_province(label)
        key = normalise(wanted)
        hit = accents.get(key)
        if hit is None:
            for candidate_key, candidate in accents.items():
                if candidate_key.endswith(key) or key.endswith(candidate_key):
                    hit = candidate
                    break
        if hit is None:
            unresolved.append((code, label))
            hit = wanted
        table[code] = hit
    if unresolved:
        print("  ! " + str(len(unresolved)) + " province labels fell back to ASCII: " + str(unresolved))
    return table


def build_places(records, admin1, limit):
    provinces = province_names(records, admin1)

    # Province centroids, used only to label the handful of records that carry no
    # admin1 code at all.
    centroids = []
    for row in records:
        if row[CODE] in ("ADM1", "ADM1H"):
            try:
                centroids.append(
                    (float(row[LAT]), float(row[LON]), provinces.get(row[ADM1_CODE], ""))
                )
            except ValueError:
                continue

    def nearest_province(lat, lon):
        best, best_km = "", 1e9
        for clat, clon, label in centroids:
            if not label:
                continue
            distance = haversine_km(lat, lon, clat, clon)
            if distance < best_km:
                best, best_km = label, distance
        return best

    candidates = []
    for row in records:
        raw_name = tidy(row[NAME])
        if normalise(raw_name) in JUNK_NAMES:
            continue
        is_place = row[CLS] == "P"
        is_commune = row[CLS] == "A" and row[CODE] in ("ADM3", "ADM3H")
        if not (is_place or is_commune):
            continue
        try:
            lat, lon = round(float(row[LAT]), 5), round(float(row[LON]), 5)
        except ValueError:
            continue
        if not (8.0 <= lat <= 23.5 and 101.9 <= lon <= 110.0):
            continue
        try:
            population = int(row[POP] or 0)
        except ValueError:
            population = 0
        code = row[CODE]
        if code == "PPLC" or population >= MUNICIPAL_POP:
            rank = 1
        elif code == "PPLA":
            rank = 2
        elif is_commune:
            rank = 4
        elif code in ("PPLA2", "PPLA3", "PPLA4", "PPLX") or population >= DISTRICT_POP:
            rank = 3
        else:
            rank = 4
        candidates.append(
            {
                "gid": int(row[GID]),
                "name": clean_place(raw_name),
                "alts": row[ALTERNATES].split(",") if row[ALTERNATES] else [],
                "rank": rank,
                "adm1": row[ADM1_CODE],
                "admin": provinces.get(row[ADM1_CODE], ""),
                "lat": lat,
                "lon": lon,
                "population": population,
            }
        )

    # A commune seat that also has a populated-place record appears twice; keep the
    # best row per (name, province).
    by_identity = {}
    for item in candidates:
        key = (compact(item["name"]), normalise(item["admin"]))
        current = by_identity.get(key)
        if current is None or (item["rank"], -item["population"]) < (
            current["rank"],
            -current["population"],
        ):
            by_identity[key] = item
    ordered = sorted(
        by_identity.values(),
        key=lambda p: (p["rank"], -p["population"], p["name"], p["gid"]),
    )

    # Drop a place that sits on top of a better-ranked one (Hanoi vs "Ha Noi"), but
    # keep the cluster so the display name can prefer the Vietnamese spelling.
    kept = []
    cluster = []
    grid = {}
    for item in ordered:
        cell = (int(item["lat"] / 0.05), int(item["lon"] / 0.05))
        match = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for lat, lon, index in grid.get((cell[0] + dx, cell[1] + dy), ()):
                    if haversine_km(item["lat"], item["lon"], lat, lon) < NEAR_KM:
                        match = index
                        break
                if match is not None:
                    break
            if match is not None:
                break
        if match is not None:
            cluster[match].append(item)
            continue
        kept.append(item)
        cluster.append([item])
        grid.setdefault(cell, []).append((item["lat"], item["lon"], len(kept) - 1))

    # Resolve the display name and the province label of every kept place.
    for item, members in zip(kept, cluster):
        aliases = list(item["alts"])
        for member in members:
            aliases.append(member["name"])
            aliases.extend(member["alts"][:40])
        item["name"] = vietnamese_name(item["name"], aliases)
        if not item["admin"]:
            item["admin"] = next((m["admin"] for m in members if m["admin"]), "")
        if not item["admin"]:
            item["admin"] = nearest_province(item["lat"], item["lon"])

    # The six municipalities are labelled in English by GeoNames; use the Vietnamese
    # name of their capital instead ("Ha Noi" with tone marks, "Hai Phong", ...).
    for code in MUNICIPALITY_CODES:
        seats = [p for p in kept if p["rank"] == 1 and p["adm1"] == code]
        if seats:
            provinces[code] = seats[0]["name"]

    # Thin rank 4 so no two labels share a tile, then hash-sample it down to the
    # limit (stable across runs, spread evenly instead of by name order).
    thinned = []
    seen = set()
    for item in kept:
        if item["rank"] < 4:
            thinned.append(item)
            continue
        cell = (int(item["lat"] / SAMPLE_STEP), int(item["lon"] / SAMPLE_STEP))
        if cell in seen:
            continue
        seen.add(cell)
        thinned.append(item)
    rank4 = [p for p in thinned if p["rank"] == 4]
    if len(rank4) > limit:
        rank4.sort(
            key=lambda p: int(hashlib.sha256(str(p["gid"]).encode()).hexdigest()[:12], 16)
        )
        keep_ids = {p["gid"] for p in rank4[:limit]}
        thinned = [p for p in thinned if p["rank"] < 4 or p["gid"] in keep_ids]

    for item in thinned:
        if item["adm1"] in MUNICIPALITY_CODES:
            item["admin"] = provinces[item["adm1"]]

    thinned.sort(key=lambda p: (p["rank"], -p["population"], normalise(p["name"]), p["gid"]))
    return [
        {
            "id": slug(p["name"]) + "-" + str(p["gid"]),
            "name": p["name"],
            "lat": p["lat"],
            "lon": p["lon"],
            "rank": p["rank"],
            "admin": p["admin"],
            "population": p["population"],
        }
        for p in thinned
    ]


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build the Vietnam place gazetteer.")
    parser.add_argument("--input", help="path to a GeoNames VN.txt dump")
    parser.add_argument("--output", default=str(OUT_DEFAULT))
    parser.add_argument("--limit", type=int, default=4500, help="rank-4 sample size")
    args = parser.parse_args(argv)

    source = ensure_vn_txt(args.input)
    admin1 = ensure_admin1()
    records = read_records(source)
    print("read " + str(len(records)) + " GeoNames records from " + str(source))
    print("admin1 reference: " + str(len(admin1)) + " provinces")

    places = build_places(records, admin1, args.limit)
    target = Path(args.output)
    target.write_text(
        json.dumps(places, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )

    counts = Counter(p["rank"] for p in places)
    payload = target.read_bytes()
    print(
        "wrote "
        + str(target)
        + " ("
        + str(round(len(payload) / 1024))
        + " kB, "
        + str(round(len(gzip.compress(payload, 9)) / 1024))
        + " kB gzip)"
    )
    print("ranks: " + ", ".join("rank" + str(k) + "=" + str(counts.get(k, 0)) for k in (1, 2, 3, 4)))
    admins = {p["admin"] for p in places}
    print("provinces covered: " + str(len(admins)) + " -> " + ", ".join(sorted(admins)))
    print("places without a province: " + str(sum(1 for p in places if not p["admin"])))
    print("rank 1: " + ", ".join(p["name"] for p in places if p["rank"] == 1))
    print("rank 2: " + ", ".join(p["name"] for p in places if p["rank"] == 2))
    print("rank 3 sample: " + ", ".join(p["name"] for p in places if p["rank"] == 3)[:260])
    print("rank 4 sample: " + ", ".join(p["name"] for p in places if p["rank"] == 4)[:260])
    return 0


if __name__ == "__main__":
    sys.exit(main())
