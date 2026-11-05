export type City = {
  id: string;
  name: string;
  region: string;
  lat: number;
  lon: number;
};
export type Hour = {
  time: string;
  temperature: number;
  humidity: number;
  rainProbability: number;
  precipitation: number;
  code: number;
  wind: number;
};

/** US EPA air quality index block, supplied per city. */
export type AirQuality = {
  aqi: number;
  pm25: number;
  pm10: number;
  ozone: number;
  no2: number;
  so2: number;
  co: number;
  category: string;
};

export type SunTimes = {
  sunrise: string;
  sunset: string;
  dawn: string;
  dusk: string;
  solarNoon: string;
  dayLength: number;
};

export type MoonPhase = {
  phase: number;
  illumination: number;
  rise: string;
  set: string;
  name: string;
};

export type WeatherAlert = {
  id: string;
  severity: "info" | "watch" | "warning" | "severe";
  title: string;
  body: string;
  region: string;
  starts: string;
  ends: string;
};

export type Weather = {
  city: City;
  source: string;
  observedAt: string;
  fetchedAt: string;
  stale: boolean;
  current: {
    temperature: number;
    feelsLike: number;
    humidity: number;
    wind: number;
    windDirection: number;
    windGust?: number;
    precipitation: number;
    code: number;
    pressure: number;
    cloudCover: number;
    visibility?: number;
    uvIndex?: number;
    dewPoint?: number;
    isDay: boolean;
  };
  hourly: Hour[];
  daily: {
    date: string;
    high: number;
    low: number;
    code: number;
    rainProbability: number;
    uv: number;
    sunrise?: string;
    sunset?: string;
    windMax?: number;
    precipitationSum?: number;
  }[];
  airQuality?: AirQuality;
  sun?: SunTimes;
  moon?: MoonPhase;
  alerts?: WeatherAlert[];
};
export type Metric = "temperature" | "precipitation" | "wind";

/** One sampled point of the gridded weather field. */
export type FieldPoint = {
  lat: number;
  lon: number;
  temperature: number;
  precipitation: number;
  wind: number;
  windDirection: number;
  code: number;
  isDay: boolean;
  humidity: number;
};

/**
 * A regular lat/lon grid of real provider values. This replaces the old
 * 25-city inverse-distance blur: every cell is its own model reading, so the
 * field on the map is dense and spatially honest.
 */
export type Field = {
  model: string;
  /** live | cache | coarse | synthetic — provenance reported by the backend. */
  source?: string;
  observedAt: string;
  fetchedAt: string;
  stale: boolean;
  cols: number;
  rows: number;
  /** [west, south, east, north] */
  bounds: [number, number, number, number];
  points: FieldPoint[];
};

/** A named place from the Vietnam gazetteer, used for on-map temperature labels. */
export type Place = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** 1 = major city, 2 = province capital, 3 = district town, 4 = commune/ward */
  rank: number;
  admin: string;
  population: number;
};

/** Provider models exposed to the UI so users can see which forecast they read. */
export type WeatherModel = {
  id: string;
  label: string;
  detail: string;
};

export const WEATHER_MODELS: WeatherModel[] = [
  { id: "ecmwf_ifs025", label: "ECMWF", detail: "European centre · 0.25°" },
  { id: "best_match", label: "Blend", detail: "Best match · multi-model" },
  { id: "icon_seamless", label: "ICON", detail: "DWD Germany · seamless" },
  { id: "gfs_seamless", label: "GFS", detail: "NOAA · seamless" },
];


/** Map basemap presentation modes. */
export type MapMode = "dark" | "satellite" | "terrain";

export type Analytics = {
  counts: { source: string; events: number; cities: number }[];
  recent: {
    event_id: string;
    city_id: string;
    event_time: string;
    source: string;
    temperature: number;
    humidity: number;
    wind: number;
  }[];
  regions: {
    region: string;
    source: string;
    events: number;
    temperature: number;
    humidity: number;
    maxWind: number;
  }[];
  spark: {
    status: string;
    updatedAt: string | null;
    queries?: {
      name: string;
      active: boolean;
      progress: {
        batchId: number;
        numInputRows: number;
        processedRowsPerSecond: number;
        stateOperators?: { numRowsTotal: number; memoryUsedBytes: number }[];
      } | null;
    }[];
    windows: {
      city_id: string;
      source: string;
      avg_temperature: number;
      max_wind: number;
      event_count: number;
      window: { start: string; end: string };
    }[];
  };
  incomingFiles: number;
  lastPoll: string | null;
  mode: string;
  providerError: string | null;
};

export const hourLabel = (t: string) =>
  new Date(t).toLocaleTimeString("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
  });

export const dayLabel = (date: string) =>
  new Date(date).toLocaleDateString("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    weekday: "short",
    day: "numeric",
  });

export const condition = (code: number) =>
  code === 0
    ? "Clear sky"
    : code === 1
      ? "Mainly clear"
      : code === 2
        ? "Partly cloudy"
        : code === 3
          ? "Overcast"
          : code < 49
            ? "Foggy"
            : code < 60
              ? "Light drizzle"
              : code < 70
                ? "Rain showers"
                : code < 80
                  ? "Snow"
                  : code < 90
                    ? "Rain showers"
                    : "Thunderstorm";

export const temperature = (v: number, f: boolean) =>
  Math.round(f ? (v * 9) / 5 + 32 : v);

/** US EPA AQI band metadata: label, tone token and colour ramp. */
export const aqiBand = (aqi: number) =>
  aqi <= 50
    ? { label: "Good", tone: "good", color: "#5ec98a" }
    : aqi <= 100
      ? { label: "Moderate", tone: "moderate", color: "#e8c569" }
      : aqi <= 150
        ? { label: "Unhealthy (sensitive)", tone: "sensitive", color: "#e79a5c" }
        : aqi <= 200
          ? { label: "Unhealthy", tone: "unhealthy", color: "#dd6a5f" }
          : aqi <= 300
            ? { label: "Very unhealthy", tone: "very", color: "#b3669e" }
            : { label: "Hazardous", tone: "hazardous", color: "#9d4b5f" };

export const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .toLowerCase();

/** True when the weather calls for a wet-condition ambient treatment. */
export const isWet = (code: number) => code >= 51;
export const isThunder = (code: number) => code >= 95;
export const isFog = (code: number) => code >= 45 && code < 50;