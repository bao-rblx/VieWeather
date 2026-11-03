"""Weather adapters. All internal times are UTC; UI renders Asia/Ho_Chi_Minh.

Pure standard library only: the solar/lunar maths, the air-quality synthesis and the
city search are all computed locally so the API has no extra dependencies.
"""

import hashlib
import math
import unicodedata
from datetime import datetime, timedelta, timezone

CURRENT = (
    "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,"
    "weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,"
    "visibility,uv_index,dew_point_2m,wind_gusts_10m"
)
HOURLY = "temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m"
DAILY = (
    "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,"
    "precipitation_probability_max,uv_index_max,wind_speed_10m_max,precipitation_sum"
)
AIR = (
    "european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,"
    "carbon_monoxide,us_aqi"
)

VN = timezone(timedelta(hours=7))
SYNODIC_MONTH = 29.530588853
NEW_MOON = datetime(2000, 1, 6, 18, 14, tzinfo=timezone.utc)
SEVERITY_ORDER = {"info": 0, "watch": 1, "warning": 2, "severe": 3}


def iso(value):
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def event_id(city_id, observed_at, source):
    return hashlib.sha256(f"{city_id}|{observed_at}|{source}".encode()).hexdigest()


def _num(value, default=None):
    """Provider payloads mix ints, floats and nulls; normalise gently."""
    if value is None or isinstance(value, bool):
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(number) or math.isinf(number):
        return default
    return number


def _rounded(value, digits=1, default=None):
    number = _num(value)
    return default if number is None else round(number, digits)


# ---------------------------------------------------------------------------
# Astronomy (NOAA solar position + synodic month). Standard library only.
# ---------------------------------------------------------------------------


def _solar_terms(day_of_year):
    """Equation of time (minutes) and solar declination (radians) for a day."""
    gamma = 2 * math.pi / 365.0 * (day_of_year - 1 + 0.5)
    eqtime = 229.18 * (
        0.000075
        + 0.001868 * math.cos(gamma)
        - 0.032077 * math.sin(gamma)
        - 0.014615 * math.cos(2 * gamma)
        - 0.040849 * math.sin(2 * gamma)
    )
    decl = (
        0.006918
        - 0.399912 * math.cos(gamma)
        + 0.070257 * math.sin(gamma)
        - 0.006758 * math.cos(2 * gamma)
        + 0.000907 * math.sin(2 * gamma)
        - 0.002697 * math.cos(3 * gamma)
        + 0.00148 * math.sin(3 * gamma)
    )
    return eqtime, decl


def _solar_minutes(lat, lon, day_of_year, zenith):
    """Minutes after UTC midnight of the local date: rise, set and solar noon."""
    eqtime, decl = _solar_terms(day_of_year)
    lat_r = math.radians(lat)
    denominator = math.cos(lat_r) * math.cos(decl)
    if abs(denominator) < 1e-9:
        denominator = 1e-9
    cos_ha = math.cos(math.radians(zenith)) / denominator - math.tan(lat_r) * math.tan(
        decl
    )
    noon = 720.0 - 4.0 * lon - eqtime
    if cos_ha >= 1.0:  # polar night: the sun never climbs to the event angle
        return None, None, noon
    if cos_ha <= -1.0:  # polar day: the sun never drops below it
        return noon - 720.0, noon + 720.0, noon
    ha = math.degrees(math.acos(cos_ha))
    return noon - 4.0 * ha, noon + 4.0 * ha, noon


def _day_reference(when):
    """Vietnam local date -> (UTC midnight of that date, day of year)."""
    local = when.astimezone(VN)
    day = local.replace(hour=0, minute=0, second=0, microsecond=0)
    reference = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    return reference, local.timetuple().tm_yday


def _sun_moments(lat, lon, when=None):
    """Datetimes of sunrise, sunset, civil dawn, civil dusk and solar noon."""
    when = when or datetime.now(timezone.utc)
    reference, day_of_year = _day_reference(when)
    rise, sset, noon = _solar_minutes(lat, lon, day_of_year, 90.833)
    dawn, dusk, _ = _solar_minutes(lat, lon, day_of_year, 96.0)
    if rise is None:
        rise, sset = noon - 360.0, noon + 360.0
    if dawn is None:
        dawn, dusk = rise - 30.0, sset + 30.0

    def at(minutes):
        return (reference + timedelta(minutes=minutes)).replace(microsecond=0)

    return {
        "sunrise": at(rise),
        "sunset": at(sset),
        "dawn": at(dawn),
        "dusk": at(dusk),
        "solarNoon": at(noon),
    }


def sun_times(lat, lon, when=None):
    """NOAA sunrise/sunset/solar-noon block. All times are ISO UTC strings."""
    when = when or datetime.now(timezone.utc)
    moments = _sun_moments(lat, lon, when)
    return {
        "sunrise": iso(moments["sunrise"]),
        "sunset": iso(moments["sunset"]),
        "dawn": iso(moments["dawn"]),
        "dusk": iso(moments["dusk"]),
        "solarNoon": iso(moments["solarNoon"]),
        "dayLength": int(round((moments["sunset"] - moments["sunrise"]).total_seconds())),
    }


def moon_phase_name(phase):
    phase = phase % 1.0
    if phase < 0.03 or phase >= 0.97:
        return "New moon"
    if phase < 0.22:
        return "Waxing crescent"
    if phase < 0.28:
        return "First quarter"
    if phase < 0.47:
        return "Waxing gibbous"
    if phase < 0.53:
        return "Full moon"
    if phase < 0.72:
        return "Waning gibbous"
    if phase < 0.78:
        return "Last quarter"
    return "Waning crescent"


def moon_times(lat, lon, when=None):
    """Moon phase plus an approximate rise/set derived from the solar day.

    The moon lags the sun by roughly one phase of a day, which is accurate to about
    half an hour for the phase group we display and needs no extra dependency.
    """
    when = when or datetime.now(timezone.utc)
    elapsed = (when - NEW_MOON).total_seconds() / 86400.0
    phase = (elapsed / SYNODIC_MONTH) % 1.0
    illumination = int(round((1 - math.cos(2 * math.pi * phase)) / 2 * 100))

    reference, day_of_year = _day_reference(when)
    rise, sset, _ = _solar_minutes(lat, lon, day_of_year, 90.833)
    rise = 360.0 if rise is None else rise
    sset = 1080.0 if sset is None else sset
    shift = phase * 1440.0
    moon_rise = (rise + shift) % 1440.0
    moon_set = (sset + shift) % 1440.0
    if moon_set <= moon_rise:
        moon_set += 1440.0
    return {
        "phase": round(phase, 4),
        "illumination": max(0, min(100, illumination)),
        "rise": iso((reference + timedelta(minutes=moon_rise)).replace(microsecond=0)),
        "set": iso((reference + timedelta(minutes=moon_set)).replace(microsecond=0)),
        "name": moon_phase_name(phase),
    }


# ---------------------------------------------------------------------------
# Air quality (US EPA AQI + Open-Meteo pollutant concentrations)
# ---------------------------------------------------------------------------

PM25_BREAKPOINTS = (
    (0.0, 12.0, 0, 50),
    (12.1, 35.4, 51, 100),
    (35.5, 55.4, 101, 150),
    (55.5, 150.4, 151, 200),
    (150.5, 250.4, 201, 300),
    (250.5, 500.4, 301, 500),
)

AQI_BANDS = (
    (50, "Good"),
    (100, "Moderate"),
    (150, "Unhealthy (sensitive)"),
    (200, "Unhealthy"),
    (300, "Very unhealthy"),
)


def aqi_category(aqi):
    for ceiling, label in AQI_BANDS:
        if aqi <= ceiling:
            return label
    return "Hazardous"


def pm25_subindex(pm25):
    """US EPA PM2.5 breakpoint interpolation (24h, ug/m3)."""
    value = max(0.0, float(pm25))
    for low, high, index_low, index_high in PM25_BREAKPOINTS:
        if value <= high:
            if value <= low:
                return index_low
            span = high - low
            ratio = (value - low) / span if span else 0.0
            return int(round(index_low + (index_high - index_low) * ratio))
    return 500


def air_quality_block(aqi, pm25, pm10, ozone, no2, so2, co):
    aqi = max(0, min(500, int(round(aqi))))
    return {
        "aqi": aqi,
        "pm25": round(float(pm25), 1),
        "pm10": round(float(pm10), 1),
        "ozone": round(float(ozone), 1),
        "no2": round(float(no2), 1),
        "so2": round(float(so2), 1),
        "co": round(float(co), 1),
        "category": aqi_category(aqi),
    }


def parse_air_quality(row):
    """Open-Meteo air-quality row -> AirQuality block, or None when unusable."""
    current = (row or {}).get("current") or {}
    pm25 = _num(current.get("pm2_5"))
    if pm25 is None:
        return None
    pm10 = _num(current.get("pm10"), round(pm25 * 1.6 + 2, 1))
    aqi = _num(current.get("us_aqi"))
    if aqi is None:
        aqi = pm25_subindex(pm25)
    return air_quality_block(
        aqi,
        pm25,
        pm10,
        _num(current.get("ozone"), 0.0),
        _num(current.get("nitrogen_dioxide"), 0.0),
        _num(current.get("sulphur_dioxide"), 0.0),
        _num(current.get("carbon_monoxide"), 0.0),
    )


AQ_PM25_BASE = {"North": 38.0, "Central": 21.0, "Highlands": 11.0, "South": 26.0}


def _seed(city):
    return int(hashlib.sha256(str(city["id"]).encode()).hexdigest()[:8], 16)


def demo_air_quality(city, now=None):
    """Deterministic, believable Vietnamese air quality for the demo adapter."""
    now = now or datetime.now(timezone.utc)
    seed = _seed(city)
    local = now.astimezone(VN)
    day_of_year = local.timetuple().tm_yday
    # Winter inversion season peaks in mid-January and clears around mid-July.
    season = math.cos((day_of_year - 15) / 365.0 * 2 * math.pi)
    base = AQ_PM25_BASE.get(city.get("region"), 22.0)
    wobble = (seed % 17) - 8.0
    pm25 = max(4.0, base * (1 + 0.35 * season) + wobble)
    pm10 = max(pm25 + 2, pm25 * 1.55 + 4 + seed % 7)
    daylight = math.sin(math.pi * (local.hour - 3) / 18.0)
    ozone = max(6.0, 52 + 26 * daylight + seed % 21)
    no2 = max(1.0, pm25 * 0.62 + 3 + seed % 9)
    so2 = 2.5 + (seed % 11) * 0.9
    co = 240 + pm25 * 22 + seed % 90
    return air_quality_block(pm25_subindex(pm25), pm25, pm10, ozone, no2, so2, co)


# ---------------------------------------------------------------------------
# Weather alerts derived from real conditions
# ---------------------------------------------------------------------------


def _alert_id(city_id, kind, stamp):
    return hashlib.sha256(f"{city_id}|{kind}|{stamp}".encode()).hexdigest()[:12]


def _alert(city, kind, severity, title, body, starts, hours):
    ends = starts + timedelta(hours=hours)
    return {
        "id": _alert_id(city["id"], kind, starts.date().isoformat()),
        "severity": severity,
        "title": title,
        "body": body,
        "region": city["region"],
        "starts": iso(starts),
        "ends": iso(ends),
    }


def _sort_alerts(alerts):
    return sorted(
        alerts,
        key=lambda a: (-SEVERITY_ORDER.get(a["severity"], 0), a["starts"], a["id"]),
    )


def build_alerts(city, current, daily, air, now=None):
    """Derive alerts from observed and forecast conditions for one city."""
    now = now or datetime.now(timezone.utc)
    starts = now.replace(minute=0, second=0, microsecond=0)
    alerts = []
    today = daily[0] if daily else {}

    rain = _num(today.get("precipitationSum")) or 0.0
    if rain >= 50:
        alerts.append(
            _alert(
                city,
                "rain",
                "severe" if rain >= 100 else "warning",
                "Heavy rain warning",
                f"{rain:.0f} mm of rain is forecast for {city['name']}. Flash flooding "
                "and ponding are possible on low-lying roads and underpasses.",
                starts,
                12,
            )
        )

    peak_wind = max(
        _num(current.get("windGust")) or 0.0,
        _num(today.get("windMax")) or 0.0,
        _num(current.get("wind")) or 0.0,
    )
    if peak_wind >= 45:
        alerts.append(
            _alert(
                city,
                "wind",
                "warning" if peak_wind >= 60 else "watch",
                "Strong wind warning" if peak_wind >= 60 else "Wind advisory",
                f"Gusts near {peak_wind:.0f} km/h are expected around {city['name']}. "
                "Secure loose outdoor items and take care on exposed roads.",
                starts,
                9,
            )
        )

    visibility = _num(current.get("visibility"))
    if visibility is not None and visibility < 1000:
        alerts.append(
            _alert(
                city,
                "fog",
                "warning",
                "Dense fog advisory",
                f"Visibility has dropped to {visibility / 1000:.1f} km near "
                f"{city['name']}. Allow extra travel time and use low-beam lights.",
                starts,
                6,
            )
        )

    aqi = _num((air or {}).get("aqi"))
    if aqi is not None and aqi >= 150:
        alerts.append(
            _alert(
                city,
                "air",
                "warning" if aqi >= 200 else "watch",
                "Air quality alert",
                f"Air quality in {city['name']} is unhealthy at AQI {int(aqi)}. "
                "Sensitive groups should avoid prolonged outdoor exertion.",
                starts,
                8,
            )
        )

    temperature = _num(current.get("temperature"))
    if temperature is not None and temperature >= 38:
        alerts.append(
            _alert(
                city,
                "heat",
                "warning",
                "Extreme heat warning",
                f"Temperatures near {temperature:.0f}C are expected in {city['name']}. "
                "Stay hydrated and avoid outdoor work during the afternoon.",
                starts,
                10,
            )
        )

    return _sort_alerts(alerts)


# Kinds are indexed by an independent hash so severity and category vary by city.
DEMO_ALERT_KINDS = (
    (
        "rain",
        "warning",
        "Heavy rain warning",
        "A tropical trough is expected to deliver 50-70 mm of rain across {region} "
        "within 12 hours. Watch for ponding on low-lying roads.",
        12,
    ),
    (
        "heat",
        "watch",
        "Heat advisory",
        "Peak heat index values near 36C persist through the afternoon across "
        "{region}. Limit outdoor exertion and keep water on hand.",
        10,
    ),
    (
        "wind",
        "watch",
        "Wind advisory",
        "Sustained winds near 45 km/h with stronger gusts are expected along the "
        "{region} coast. Small craft should remain in harbour.",
        9,
    ),
    (
        "air",
        "watch",
        "Air quality notice",
        "Fine particulate levels are elevated across {region}. Sensitive groups "
        "should reduce prolonged outdoor activity.",
        8,
    ),
    (
        "fog",
        "info",
        "Morning visibility reduced",
        "Patchy valley fog is expected around sunrise across {region}, clearing by "
        "mid-morning.",
        5,
    ),
)

# Salted rolls keep the demo alert spread deterministic without touching the
# weather values themselves; roughly a quarter of the cities carry an alert.
DEMO_ALERT_SALT = "vw-alert-74"


def _roll(salt, city_id):
    return int(hashlib.sha256(f"{salt}|{city_id}".encode()).hexdigest()[:8], 16)


def demo_alerts(city, now=None):
    """Deterministic, plausible alerts for demo mode (about one in four cities)."""
    now = now or datetime.now(timezone.utc)
    starts = now.replace(minute=0, second=0, microsecond=0)
    alerts = []
    if _roll(DEMO_ALERT_SALT, city["id"]) % 100 >= 26:
        return alerts
    kind, severity, title, body, hours = DEMO_ALERT_KINDS[
        _roll(DEMO_ALERT_SALT + "-kind", city["id"]) % len(DEMO_ALERT_KINDS)
    ]
    alerts.append(
        _alert(
            city,
            kind,
            severity,
            title,
            body.format(region=city["region"]),
            starts,
            hours,
        )
    )
    if _roll(DEMO_ALERT_SALT + "-extra", city["id"]) % 100 < 14:
        alerts.append(
            _alert(
                city,
                "thunder",
                "info",
                "Thunderstorm outlook",
                f"Isolated thunderstorms are possible over {city['region']} this "
                "evening with brief heavy downpours.",
                starts,
                6,
            )
        )
    return _sort_alerts(alerts)


# ---------------------------------------------------------------------------
# Forecast adapters
# ---------------------------------------------------------------------------


def dew_point(temperature, humidity):
    """Magnus formula; matches the provider to about 0.2 degrees."""
    temperature = _num(temperature)
    humidity = _num(humidity)
    if temperature is None or humidity is None:
        return None
    limit = max(1.0, min(100.0, humidity))
    gamma = math.log(limit / 100.0) + (17.62 * temperature) / (243.12 + temperature)
    return round((243.12 * gamma) / (17.62 - gamma), 1)


def demo_weather(city, now=None):
    now = now or datetime.now(timezone.utc)
    seed = sum(map(ord, city["id"]))
    base = 29 - (city["lat"] - 10) * 0.45 - (5 if city["region"] == "Highlands" else 0)

    def temp(dt):
        return round(
            base
            + 3 * math.sin(((dt.hour + 7) % 24 - 8) * math.pi / 12)
            + math.sin(seed) * 1.4,
            1,
        )

    start = now.replace(minute=0, second=0, microsecond=0)
    hourly = []
    for i in range(168):
        dt = start + timedelta(hours=i)
        rain = max(0, round(1.8 * math.sin(seed + i / 4), 1))
        hourly.append(
            {
                "time": iso(dt),
                "temperature": temp(dt),
                "humidity": 65 + (seed + i) % 25,
                "rainProbability": round(rain * 42),
                "precipitation": rain,
                "code": 61 if rain > 0.9 else 2,
                "wind": round(8 + (seed + i) % 15, 1),
            }
        )
    local = now.astimezone(VN)
    daily = []
    for i in range(7):
        window = hourly[i * 24 : (i + 1) * 24]
        day_date = (local + timedelta(days=i)).date()
        day_moments = _sun_moments(city["lat"], city["lon"], now + timedelta(days=i))
        daily.append(
            {
                "date": day_date.isoformat(),
                "high": round(base + 3 + i % 3, 1),
                "low": round(base - 3 - i % 2, 1),
                "code": 61 if i % 3 == 1 else 2,
                "rainProbability": 25 + (seed + i * 11) % 65,
                "uv": 6 + i % 4,
                "sunrise": iso(day_moments["sunrise"]),
                "sunset": iso(day_moments["sunset"]),
                "windMax": round(
                    max((h["wind"] for h in window), default=8 + seed % 15), 1
                ),
                "precipitationSum": round(sum(h["precipitation"] for h in window), 1),
            }
        )

    current_temperature = temp(now)
    humidity = 65 + seed % 25
    wind = 8 + seed % 15
    code = hourly[0]["code"]
    moments = _sun_moments(city["lat"], city["lon"], now)
    uv_peak = max(4.0, 12 - abs(city["lat"] - 10) * 0.25)
    uv = (
        round(uv_peak * math.sin(math.pi * (local.hour - 6) / 12), 1)
        if 6 <= local.hour < 18
        else 0.0
    )
    if 45 <= code < 50:
        visibility = 900.0
    elif code >= 61:
        visibility = 6500.0
    else:
        visibility = float(16000 + seed % 4000)

    current = {
        "temperature": current_temperature,
        "feelsLike": round(current_temperature + 1.8, 1),
        "humidity": humidity,
        "wind": wind,
        "windDirection": seed % 360,
        "windGust": round(wind * 1.6, 1),
        "precipitation": hourly[0]["precipitation"],
        "code": code,
        "pressure": 1008 + seed % 10,
        "cloudCover": 35 + seed % 60,
        "visibility": visibility,
        "uvIndex": uv,
        "dewPoint": dew_point(current_temperature, humidity),
        "isDay": moments["sunrise"] <= now <= moments["sunset"],
    }
    air = demo_air_quality(city, now)
    return {
        "city": city,
        "source": "demo",
        "observedAt": iso(now),
        "fetchedAt": iso(now),
        "current": current,
        "hourly": hourly,
        "daily": daily,
        "airQuality": air,
        "sun": sun_times(city["lat"], city["lon"], now),
        "moon": moon_times(city["lat"], city["lon"], now),
        "alerts": demo_alerts(city, now),
    }


def parse_live(city, data, now=None, air=None, extras=None):
    """Provider rows -> Weather payload.

    ECMWF, the model the map field reads (and the one Windy shows), does not publish
    visibility or UV, so the collector supplies a second, tiny best_match payload as
    "extras" to fill those four numbers. Everything else comes from the primary model.
    """
    now = now or datetime.now(timezone.utc)
    c, h, d = data["current"], data["hourly"], data["daily"]
    extra_current = (extras or {}).get("current") or {}
    extra_daily = (extras or {}).get("daily") or {}
    extra_uv = extra_daily.get("uv_index_max") or []
    primary_uv = d.get("uv_index_max") or []

    def daily_uv(index):
        primary = primary_uv[index] if index < len(primary_uv) else None
        return _num(primary, extra_uv[index] if index < len(extra_uv) else None)

    def stamp(t):
        return iso(datetime.fromtimestamp(t, timezone.utc))

    hourly = [
        {
            "time": stamp(t),
            "temperature": h["temperature_2m"][i],
            "humidity": h["relative_humidity_2m"][i],
            "rainProbability": h["precipitation_probability"][i],
            "precipitation": h["precipitation"][i],
            "code": h["weather_code"][i],
            "wind": h["wind_speed_10m"][i],
        }
        for i, t in enumerate(h["time"])
        if t >= now.timestamp() - 3600
    ]
    daily_sunrise = d.get("sunrise") or []
    daily_sunset = d.get("sunset") or []
    daily_wind = d.get("wind_speed_10m_max") or []
    daily_precipitation = d.get("precipitation_sum") or []

    daily = []
    for i, t in enumerate(d["time"]):
        day = (datetime.fromtimestamp(t, timezone.utc) + timedelta(hours=7)).date()
        reference = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
        fallback = _sun_moments(city["lat"], city["lon"], reference)
        daily.append(
            {
                "date": day.isoformat(),
                "high": d["temperature_2m_max"][i],
                "low": d["temperature_2m_min"][i],
                "code": d["weather_code"][i],
                "rainProbability": d["precipitation_probability_max"][i],
                "uv": daily_uv(i),
                "sunrise": stamp(daily_sunrise[i])
                if i < len(daily_sunrise)
                else iso(fallback["sunrise"]),
                "sunset": stamp(daily_sunset[i])
                if i < len(daily_sunset)
                else iso(fallback["sunset"]),
                "windMax": daily_wind[i] if i < len(daily_wind) else None,
                "precipitationSum": daily_precipitation[i]
                if i < len(daily_precipitation)
                else None,
            }
        )

    temperature = c["temperature_2m"]
    humidity = c["relative_humidity_2m"]
    wind = c["wind_speed_10m"]
    current = {
        "temperature": temperature,
        "feelsLike": c["apparent_temperature"],
        "humidity": humidity,
        "wind": wind,
        "windDirection": c["wind_direction_10m"],
        "windGust": _num(c.get("wind_gusts_10m"), round(wind * 1.5, 1)),
        "precipitation": c["precipitation"],
        "code": c["weather_code"],
        "pressure": c["pressure_msl"],
        "cloudCover": c["cloud_cover"],
        "visibility": _num(
            c.get("visibility"), _num(extra_current.get("visibility"), 20000.0)
        ),
        "uvIndex": _num(c.get("uv_index"), _num(extra_current.get("uv_index"), 0.0)),
        "dewPoint": _num(c.get("dew_point_2m"), dew_point(temperature, humidity)),
        "isDay": bool(c["is_day"]),
    }
    # Accept either a raw provider row or a block already built by parse_air_quality.
    if not isinstance(air, dict):
        air_quality = None
    elif "current" in air:
        air_quality = parse_air_quality(air)
    else:
        air_quality = air
    return {
        "city": city,
        "source": "open-meteo",
        "observedAt": stamp(c["time"]),
        "fetchedAt": iso(now),
        "current": current,
        "hourly": hourly,
        "daily": daily,
        "airQuality": air_quality,
        "sun": sun_times(city["lat"], city["lon"], now),
        "moon": moon_times(city["lat"], city["lon"], now),
        "alerts": build_alerts(city, current, daily, air_quality, now),
    }


def observation(weather):
    c = weather["current"]
    return {
        "event_id": event_id(
            weather["city"]["id"], weather["observedAt"], weather["source"]
        ),
        "city_id": weather["city"]["id"],
        "region": weather["city"]["region"],
        "event_time": weather["observedAt"],
        "ingested_at": weather["fetchedAt"],
        "source": weather["source"],
        "temperature": c["temperature"],
        "humidity": c["humidity"],
        "wind": c["wind"],
        "precipitation": c["precipitation"],
    }


# ---------------------------------------------------------------------------
# City search: accent-insensitive and ranked
# ---------------------------------------------------------------------------

_FOLD = str.maketrans({"\u0111": "d", "\u0110": "D"})


def normalize_text(value):
    """Lowercase ASCII fold; accented and unaccented spellings collapse together."""
    folded = unicodedata.normalize("NFD", str(value).translate(_FOLD))
    stripped = "".join(ch for ch in folded if not unicodedata.combining(ch))
    return " ".join(stripped.lower().split())


def _token_score(token, name, region, slug):
    if name == token:
        return 1000
    compact = name.replace(" ", "")
    if len(token) > 1 and compact == token:
        return 950
    initials = "".join(word[0] for word in name.split() if word)
    if len(token) > 1 and initials.startswith(token):
        return 850
    if name.startswith(token):
        return 900
    if any(word.startswith(token) for word in name.split()):
        return 800
    if token in name:
        return 700
    if len(token) > 2 and token in compact:
        return 690
    if slug.startswith(token):
        return 660
    if token in slug:
        return 620
    if region.startswith(token):
        return 520
    if token in region:
        return 470
    return 0


def search_cities(cities, query, limit=8):
    """Rank cities by accent-insensitive prefix and substring match."""
    limit = max(1, int(limit))
    payload = [
        {
            "id": c["id"],
            "name": c["name"],
            "region": c["region"],
            "lat": c["lat"],
            "lon": c["lon"],
        }
        for c in cities
    ]
    tokens = normalize_text(query).split()
    if not tokens:
        return payload[:limit]
    condensed = normalize_text(query).replace(" ", "")
    ranked = []
    for city, item in zip(cities, payload):
        name = normalize_text(city["name"])
        region = normalize_text(city["region"])
        slug = normalize_text(city["id"].replace("-", " "))
        scores = [_token_score(token, name, region, slug) for token in tokens]
        if any(score == 0 for score in scores):
            continue
        score = sum(scores)
        if condensed and condensed in name.replace(" ", ""):
            score += 120
        if name.startswith(tokens[0]):
            score += 40
        ranked.append((score, item))
    ranked.sort(key=lambda row: (-row[0], row[1]["name"]))
    return [item for _, item in ranked[:limit]]
