import {
  type Weather,
  type Metric,
  type Field,
  type Place,
} from "./types";

/**
 * weatherField.ts - the numerical side of the map.
 *
 * Two sampling strategies live here behind one interface:
 *  - a real provider grid (/api/field, the dense open-meteo reading) sampled
 *    bilinearly, which is what the map uses once the backend is up;
 *  - a 25-city inverse-distance fallback that keeps the map alive when the
 *    grid endpoint is unavailable.
 *
 * makeWeatherImage / sampleWind keep their original arguments, so older call
 * sites and the city-only mode keep working.
 */

/** Colour ramps shared by the field image, the 3D columns and the legend. */
export const scales: Record<Metric, [number, number[]][]> = {
  wind: [
    [0, [64, 89, 151]],
    [8, [48, 131, 164]],
    [16, [51, 164, 139]],
    [24, [143, 179, 89]],
    [32, [213, 177, 77]],
    [40, [191, 102, 102]],
  ],
  temperature: [
    [15, [67, 119, 184]],
    [20, [71, 171, 162]],
    [25, [175, 190, 83]],
    [30, [228, 169, 70]],
    [35, [214, 98, 66]],
    [40, [159, 61, 105]],
  ],
  precipitation: [
    [0, [47, 92, 130]],
    [2, [48, 150, 167]],
    [4, [70, 175, 126]],
    [6, [174, 186, 75]],
    [8, [221, 147, 74]],
    [10, [179, 86, 137]],
  ],
};

type Bounds = [number, number, number, number]; // west, south, east, north

/**
 * Fallback extent. The real grid extent travels with each /api/field payload in
 * `field.bounds`; this constant only covers the city-only path and the case where
 * the API has not answered yet. It matches backend/field.py GRID_BOUNDS, which
 * reaches 114.5 E so the Hoang Sa and Truong Sa archipelagos are inside the field.
 */
export const DATA_BOUNDS: Bounds = [102.0, 8.6, 114.5, 23.4];

/** Kept for callers of the old city-only path. */
export const FIELD_BOUNDS: Bounds = DATA_BOUNDS;

/**
 * The colour raster is drawn well beyond the sampled grid: the sampler clamps
 * to the nearest edge cell, so the field keeps going past the data and only the
 * alpha feathers out. That is what removes the "pasted rectangle" edge.
 */
export const FILL_PAD = 5.2;

/** Extent used by the legacy city-interpolation image. */
export const LEGACY_BOUNDS: Bounds = DATA_BOUNDS;

export const FILL_BOUNDS: Bounds = [
  DATA_BOUNDS[0] - FILL_PAD,
  DATA_BOUNDS[1] - FILL_PAD,
  DATA_BOUNDS[2] + FILL_PAD,
  DATA_BOUNDS[3] + FILL_PAD,
];

/**
 * A transparent 1x1 image for the initial value of the image source. It is
 * generated from a canvas because MapLibre's decoder rejects older
 * hand-written 1x1 base64 PNGs.
 */
const transparentPixel = () => {
  if (typeof document === "undefined") return "";
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  return canvas.toDataURL();
};

export const blankImage = transparentPixel();

const BLANK = blankImage;

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

/** Linear colour lookup against the metric ramp. */
function ramp(value: number, metric: Metric): [number, number, number] {
  const stops = scales[metric];
  if (!(value > stops[0][0])) {
    const first = stops[0][1];
    return [first[0], first[1], first[2]];
  }
  for (let i = 1; i < stops.length; i++) {
    if (value <= stops[i][0]) {
      const [lo, start] = stops[i - 1];
      const [hi, end] = stops[i];
      const t = clamp((value - lo) / (hi - lo || 1), 0, 1);
      return [
        Math.round(start[0] + (end[0] - start[0]) * t),
        Math.round(start[1] + (end[1] - start[1]) * t),
        Math.round(start[2] + (end[2] - start[2]) * t),
      ];
    }
  }
  const last = stops[stops.length - 1][1];
  return [last[0], last[1], last[2]];
}

const LUT_SIZE = 512;
const lutCache = new Map<Metric, { min: number; max: number; lut: Uint8Array }>();

/** 512-entry colour lookup table so the pixel loop never walks the stops. */
function colourLut(metric: Metric) {
  const cached = lutCache.get(metric);
  if (cached) return cached;
  const stops = scales[metric];
  const min = stops[0][0] - 6;
  const max = stops[stops.length - 1][0] + 6;
  const lut = new Uint8Array(LUT_SIZE * 3);
  for (let i = 0; i < LUT_SIZE; i++) {
    const value = min + ((max - min) * i) / (LUT_SIZE - 1);
    const rgb = ramp(value, metric);
    lut[i * 3] = rgb[0];
    lut[i * 3 + 1] = rgb[1];
    lut[i * 3 + 2] = rgb[2];
  }
  const entry = { min, max, lut };
  lutCache.set(metric, entry);
  return entry;
}

/** Normalise [w,s,e,n] whatever order the payload used. */
function ordered(bounds: Bounds): Bounds {
  const [a, b, c, d] = bounds;
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

type Channel = "temperature" | "precipitation" | "wind";

type Grid = {
  cols: number;
  rows: number;
  w: number;
  s: number;
  e: number;
  n: number;
  /** latitude of row 0 and of the last row (the grid may be north- or south-first). */
  lat0: number;
  lat1: number;
  temperature: Float32Array;
  precipitation: Float32Array;
  wind: Float32Array;
  /** wind vector (km/h) already converted from "from" to "towards". */
  u: Float32Array;
  v: Float32Array;
};

type Delta = {
  cols: number;
  rows: number;
  w: number;
  s: number;
  e: number;
  n: number;
  temperature: Float32Array;
  precipitation: Float32Array;
  wind: Float32Array;
};

function buildGrid(field: Field): Grid | null {
  const cols = Math.max(1, Math.round(field.cols || 0));
  const rows = Math.max(1, Math.round(field.rows || 0));
  const points = field.points || [];
  if (!points.length || points.length < cols * rows) return null;
  const [w, s, e, n] = ordered(field.bounds || FIELD_BOUNDS);
  const lat0 = points[0].lat;
  const lat1 = points[(rows - 1) * cols].lat;
  const total = cols * rows;
  const grid: Grid = {
    cols,
    rows,
    w,
    s,
    e,
    n,
    lat0,
    lat1,
    temperature: new Float32Array(total),
    precipitation: new Float32Array(total),
    wind: new Float32Array(total),
    u: new Float32Array(total),
    v: new Float32Array(total),
  };
  for (let i = 0; i < total; i++) {
    const p = points[i];
    grid.temperature[i] = Number.isFinite(p.temperature) ? p.temperature : 0;
    grid.precipitation[i] = Number.isFinite(p.precipitation)
      ? p.precipitation
      : 0;
    const speed = Number.isFinite(p.wind) ? p.wind : 0;
    grid.wind[i] = speed;
    // Meteorological direction is where the wind comes FROM; particles travel TO.
    const dir = ((p.windDirection || 0) * Math.PI) / 180;
    grid.u[i] = -Math.sin(dir) * speed;
    grid.v[i] = -Math.cos(dir) * speed;
  }
  return grid;
}

function bilinear(
  arr: Float32Array,
  cols: number,
  rows: number,
  fx: number,
  fy: number,
): number {
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = arr[y0 * cols + x0];
  const b = arr[y0 * cols + x1];
  const c = arr[y1 * cols + x0];
  const d = arr[y1 * cols + x1];
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

function frac(
  w: number,
  e: number,
  s: number,
  n: number,
  lon: number,
  lat: number,
) {
  const fx = e - w === 0 ? 0 : clamp((lon - w) / (e - w), 0, 1);
  const fy = n - s === 0 ? 0 : clamp((lat - s) / (n - s), 0, 1);
  return [fx, fy] as const;
}

const DELTA_COLS = 27;
const DELTA_ROWS = 25;

/**
 * Hourly deltas on top of the grid: the grid is a "now" snapshot, but the app
 * has an hour scrubber. We keep scrubbing honest by blending a smooth
 * (hour - now) anomaly derived from the city forecasts into the grid.
 */
function buildDelta(weather: Weather[], hour: number, grid: Grid): Delta | null {
  if (hour <= 0 || !weather.length) return null;
  const cols = DELTA_COLS;
  const rows = DELTA_ROWS;
  const total = cols * rows;
  const out: Delta = {
    cols,
    rows,
    w: grid.w,
    s: grid.s,
    e: grid.e,
    n: grid.n,
    temperature: new Float32Array(total),
    precipitation: new Float32Array(total),
    wind: new Float32Array(total),
  };
  const cities: { lon: number; lat: number; d: [number, number, number] }[] = [];
  for (const w of weather) {
    const h = w.hourly[hour];
    if (!h) continue;
    cities.push({
      lon: w.city.lon,
      lat: w.city.lat,
      d: [
        h.temperature - w.current.temperature,
        h.precipitation - w.current.precipitation,
        h.wind - w.current.wind,
      ],
    });
  }
  if (!cities.length) return null;
  for (let r = 0; r < rows; r++) {
    const lat = grid.s + ((grid.n - grid.s) * r) / (rows - 1);
    for (let c = 0; c < cols; c++) {
      const lon = grid.w + ((grid.e - grid.w) * c) / (cols - 1);
      let sumT = 0;
      let sumP = 0;
      let sumW = 0;
      let wsum = 0;
      for (const city of cities) {
        const dy = lat - city.lat;
        const dx = (lon - city.lon) * Math.cos((lat * Math.PI) / 180);
        const d2 = dx * dx + dy * dy;
        const weight = 1 / (Math.pow(d2, 1.15) + 0.055);
        sumT += city.d[0] * weight;
        sumP += city.d[1] * weight;
        sumW += city.d[2] * weight;
        wsum += weight;
      }
      const i = r * cols + c;
      out.temperature[i] = sumT / wsum;
      out.precipitation[i] = sumP / wsum;
      out.wind[i] = sumW / wsum;
    }
  }
  return out;
}

function cityValue(
  city: Weather,
  hour: number,
  metric: Metric,
): number {
  if (hour === 0) return city.current[metric];
  const h = city.hourly[hour];
  return h ? h[metric] : city.current[metric];
}

function idwValue(
  weather: Weather[],
  metric: Metric,
  lon: number,
  lat: number,
  hour: number,
) {
  let sum = 0;
  let weights = 0;
  for (const w of weather) {
    const dy = lat - w.city.lat;
    const dx = (lon - w.city.lon) * Math.cos((lat * Math.PI) / 180);
    const d2 = dx * dx + dy * dy;
    const weight = 1 / (d2 * d2 + 0.025);
    sum += cityValue(w, hour, metric) * weight;
    weights += weight;
  }
  return weights ? sum / weights : 0;
}

function idwWind(weather: Weather[], lon: number, lat: number, hour: number) {
  let u = 0;
  let v = 0;
  let weights = 0;
  let nearest = Infinity;
  for (const w of weather) {
    const dy = lat - w.city.lat;
    const dx = (lon - w.city.lon) * Math.cos((lat * Math.PI) / 180);
    const d2 = dx * dx + dy * dy;
    nearest = Math.min(nearest, d2);
    const weight = 1 / (d2 * d2 + 0.025);
    const speed =
      hour === 0 ? w.current.wind : (w.hourly[hour]?.wind ?? w.current.wind);
    const dir = (w.current.windDirection * Math.PI) / 180;
    u += -Math.sin(dir) * speed * weight;
    v += -Math.cos(dir) * speed * weight;
    weights += weight;
  }
  if (!weights) return null;
  return { u: u / weights, v: v / weights, near: nearest < 10 };
}

/**
 * Uniform sampler over grid-or-city data. Create it once per
 * (field, weather, hour) combination and reuse it: labels, the field image and
 * the wind particles all read the same numbers from it.
 */
export type FieldSampler = {
  grid: Grid | null;
  delta: Delta | null;
  /** true when the grid exists, i.e. the map is reading real model data. */
  gridded: boolean;
  /** false before any weather has arrived: callers should draw nothing. */
  hasData: boolean;
  bounds: Bounds;
  inside(lon: number, lat: number): boolean;
  value(metric: Metric, lon: number, lat: number): number;
  wind(lon: number, lat: number): { u: number; v: number } | null;
};

export function createSampler(
  field: Field | null | undefined,
  weather: Weather[],
  hour: number,
): FieldSampler {
  const grid = field ? buildGrid(field) : null;
  const delta = grid ? buildDelta(weather, hour, grid) : null;
  const bounds = grid
    ? ordered([grid.w, grid.s, grid.e, grid.n] as Bounds)
    : ordered(field?.bounds ?? FIELD_BOUNDS);

  const value = (metric: Metric, lon: number, lat: number) => {
    if (!grid) return idwValue(weather, metric, lon, lat, hour);
    const [fx, fy] = frac(grid.w, grid.e, grid.lat0, grid.lat1, lon, lat);
    const channel: Channel = metric;
    const base = bilinear(
      grid[channel],
      grid.cols,
      grid.rows,
      fx * (grid.cols - 1),
      fy * (grid.rows - 1),
    );
    if (!delta) return base;
    const [dx, dy] = frac(delta.w, delta.e, delta.s, delta.n, lon, lat);
    return (
      base +
      bilinear(
        delta[channel],
        delta.cols,
        delta.rows,
        dx * (delta.cols - 1),
        dy * (delta.rows - 1),
      )
    );
  };

  const wind = (lon: number, lat: number) => {
    if (!grid) {
      const legacy = idwWind(weather, lon, lat, hour);
      return legacy && legacy.near ? { u: legacy.u, v: legacy.v } : null;
    }
    const [fx, fy] = frac(grid.w, grid.e, grid.lat0, grid.lat1, lon, lat);
    return {
      u: bilinear(
        grid.u,
        grid.cols,
        grid.rows,
        fx * (grid.cols - 1),
        fy * (grid.rows - 1),
      ),
      v: bilinear(
        grid.v,
        grid.cols,
        grid.rows,
        fx * (grid.cols - 1),
        fy * (grid.rows - 1),
      ),
    };
  };

  return {
    grid,
    delta,
    gridded: Boolean(grid),
    hasData: Boolean(grid) || weather.length > 0,
    bounds,
    inside: (lon, lat) =>
      lon >= bounds[0] - 0.02 &&
      lon <= bounds[2] + 0.02 &&
      lat >= bounds[1] - 0.02 &&
      lat <= bounds[3] + 0.02,
    value,
    wind,
  };
}

/** Image corners for the map image source: top-left, top-right, bottom-right, bottom-left. */
export function weatherImageCoordinates(
  field?: Field | null,
): [[number, number], [number, number], [number, number], [number, number]] {
  const [w, s, e, n] = field ? ordered(field.bounds) : LEGACY_BOUNDS;
  const p = FILL_PAD;
  return [
    [w - p, n + p],
    [e + p, n + p],
    [e + p, s - p],
    [w - p, s - p],
  ];
}

const IMAGE_W = 560;
const IMAGE_H = 780;

const mercatorY = (lat: number) =>
  Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const unMercatorY = (y: number) =>
  (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * (180 / Math.PI);

const smoothstep = (t: number) => {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
};

/**
 * Renders the field colour raster. The grid is resampled bilinearly in mercator
 * space so it lines up with the tile basemap; past the sampled area the nearest
 * edge value is carried on and only the alpha feathers out, so the layer blends
 * into the basemap instead of ending on a straight edge.
 */
export function renderWeatherCanvas(
  weather: Weather[],
  metric: Metric,
  hour: number,
  field?: Field | null,
): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const [w, s, e, n] = field ? ordered(field.bounds) : DATA_BOUNDS;
  const pad = FILL_PAD;
  const west = w - pad;
  const east = e + pad;
  const south = s - pad;
  const north = n + pad;
  const sampler = createSampler(field ?? null, weather, hour);
  const { min, max, lut } = colourLut(metric);
  const span = max - min || 1;
  const canvas = document.createElement("canvas");
  canvas.width = IMAGE_W;
  canvas.height = IMAGE_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const image = ctx.createImageData(IMAGE_W, IMAGE_H);
  const data = image.data;
  const yNorth = mercatorY(north);
  const ySouth = mercatorY(south);
  for (let y = 0; y < IMAGE_H; y++) {
    const lat = unMercatorY(yNorth + ((ySouth - yNorth) * y) / (IMAGE_H - 1));
    const outsideLat = Math.max(0, s - lat, lat - n);
    for (let x = 0; x < IMAGE_W; x++) {
      const lon = west + ((east - west) * x) / (IMAGE_W - 1);
      const value = sampler.value(metric, lon, lat);
      const index = (((value - min) / span) * (LUT_SIZE - 1)) | 0;
      const clamped = index < 0 ? 0 : index > LUT_SIZE - 1 ? LUT_SIZE - 1 : index;
      // Past the sampled rectangle the nearest edge value is carried on and
      // only the alpha feathers out, so no straight edge is ever visible.
      const outside = Math.max(outsideLat, Math.max(0, w - lon, lon - e));
      const alpha =
        outside <= 0 ? 1 : smoothstep(1 - outside / pad);
      const o = (y * IMAGE_W + x) * 4;
      const c = clamped * 3;
      data[o] = lut[c];
      data[o + 1] = lut[c + 1];
      data[o + 2] = lut[c + 2];
      data[o + 3] = (alpha * 255) | 0;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Same field raster as a data URL. Kept for callers that need a string.
 */
export function makeWeatherImage(
  weather: Weather[],
  metric: Metric,
  hour: number,
  field?: Field | null,
): string {
  const canvas = renderWeatherCanvas(weather, metric, hour, field);
  return canvas ? canvas.toDataURL() : BLANK;
}

/**
 * Wind vector at a location, in km/h, already rotated into map space
 * (u = east, v = north). Accepts either a prepared sampler (preferred: the
 * particle loop calls this thousands of times per second) or a raw field.
 */
export function sampleWind(
  weather: Weather[],
  lon: number,
  lat: number,
  hour: number,
  field?: Field | FieldSampler | null,
) {
  if (field && typeof (field as FieldSampler).value === "function") {
    return (field as FieldSampler).wind(lon, lat);
  }
  const sampler = createSampler((field as Field | null) ?? null, weather, hour);
  return sampler.wind(lon, lat);
}

export type PlaceFeatureProperties = {
  id: string;
  name: string;
  rank: number;
  /** Numeric reading, already unit-converted and rounded. */
  value: string;
  unit: string;
  /** Descending-population sort key so the biggest names win collisions. */
  sortKey: number;
  gridded: number;
};

export type PlaceGeoJSON = {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    properties: PlaceFeatureProperties;
    geometry: { type: "Point"; coordinates: [number, number] };
  }[];
};

const reading = (
  metric: Metric,
  fahrenheit: boolean,
  v: number,
): { value: string; unit: string } =>
  metric === "temperature"
    ? {
        value: String(Math.round(fahrenheit ? (v * 9) / 5 + 32 : v)),
        unit: "\u00b0",
      }
    : metric === "wind"
      ? { value: String(Math.round(v)), unit: " km/h" }
      : { value: v.toFixed(1), unit: " mm" };

/**
 * Turns the gazetteer into label features: name plus the temperature read from
 * the grid at that exact coordinate. Places outside the sampled area keep their
 * name but hide the number rather than showing a made-up one.
 */
export function buildPlaceGeoJSON(
  places: Place[],
  sampler: FieldSampler,
  metric: Metric,
  fahrenheit: boolean,
): PlaceGeoJSON {
  const features: PlaceGeoJSON["features"] = [];
  for (const place of places) {
    const inside = sampler.inside(place.lon, place.lat);
    const value = inside
      ? reading(
          metric,
          fahrenheit,
          sampler.value(metric, place.lon, place.lat),
        )
      : { value: "", unit: "" };
    features.push({
      type: "Feature",
      properties: {
        id: place.id,
        name: place.name,
        rank: place.rank,
        value: value.value,
        unit: value.unit,
        sortKey: -(place.population || 0),
        gridded: sampler.gridded ? 1 : 0,
      },
      geometry: { type: "Point", coordinates: [place.lon, place.lat] },
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * Client-side grid built from the city forecasts. Used until the field
 * endpoint lands (and whenever it fails) so the map never regresses to a blur.
 */
export function synthesizeField(weather: Weather[], hour = 0): Field | null {
  if (!weather.length) return null;
  const cols = 22;
  const rows = 20;
  const [w, s, e, n] = FIELD_BOUNDS;
  const points = [];
  for (let r = 0; r < rows; r++) {
    const lat = s + ((n - s) * r) / (rows - 1);
    for (let c = 0; c < cols; c++) {
      const lon = w + ((e - w) * c) / (cols - 1);
      let nearest = weather[0];
      let nearestD = Infinity;
      for (const city of weather) {
        const dy = lat - city.city.lat;
        const dx = (lon - city.city.lon) * Math.cos((lat * Math.PI) / 180);
        const d2 = dx * dx + dy * dy;
        if (d2 < nearestD) {
          nearestD = d2;
          nearest = city;
        }
      }
      const h = hour > 0 ? nearest.hourly[hour] : undefined;
      points.push({
        lat: Number(lat.toFixed(3)),
        lon: Number(lon.toFixed(3)),
        temperature: h ? h.temperature : nearest.current.temperature,
        precipitation: h ? h.precipitation : nearest.current.precipitation,
        wind: h ? h.wind : nearest.current.wind,
        windDirection: nearest.current.windDirection,
        code: h ? h.code : nearest.current.code,
        isDay: nearest.current.isDay,
        humidity: h ? h.humidity : nearest.current.humidity,
      });
    }
  }
  return {
    model: "city-blend",
    observedAt: weather[0].observedAt,
    fetchedAt: weather[0].fetchedAt,
    stale: weather.every((x) => x.stale),
    cols,
    rows,
    bounds: [w, s, e, n],
    points,
  };
}

/** Compact gazetteer used when the places endpoint is not available. */
const RAW_PLACES: [string, string, number, number, number, string, number][] = [
  ["hanoi", "Hà Nội", 21.0285, 105.8542, 1, "Hà Nội", 8053663],
  ["hcmc", "TP. Hồ Chí Minh", 10.8231, 106.6297, 1, "Hồ Chí Minh", 9000000],
  ["da-nang", "Đà Nẵng", 16.0544, 108.2022, 1, "Đà Nẵng", 1200000],
  ["hai-phong", "Hải Phòng", 20.8449, 106.6881, 1, "Hải Phòng", 2100000],
  ["can-tho", "Cần Thơ", 10.0452, 105.7469, 1, "Cần Thơ", 1250000],
  ["hue", "Huế", 16.4637, 107.5909, 2, "Thừa Thiên Huế", 650000],
  ["bien-hoa", "Biên Hòa", 10.9574, 106.8427, 2, "Đồng Nai", 800000],
  ["nha-trang", "Nha Trang", 12.2388, 109.1967, 2, "Khánh Hòa", 420000],
  ["da-lat", "Đà Lạt", 11.9404, 108.4583, 2, "Lâm Đồng", 230000],
  ["vung-tau", "Vũng Tàu", 10.4114, 107.1362, 2, "Bà Rịa - Vũng Tàu", 350000],
  ["quy-nhon", "Quy Nhơn", 13.782, 109.219, 2, "Bình Định", 300000],
  ["buon-ma-thuot", "Buôn Ma Thuột", 12.6667, 108.05, 2, "Đắk Lắk", 340000],
  ["vinh", "Vinh", 18.6796, 105.6813, 2, "Nghệ An", 490000],
  ["thanh-hoa", "Thanh Hóa", 19.8075, 105.7764, 2, "Thanh Hóa", 400000],
  ["ha-long", "Hạ Long", 20.9505, 107.0734, 2, "Quảng Ninh", 270000],
  ["thai-nguyen", "Thái Nguyên", 21.5928, 105.8442, 2, "Thái Nguyên", 340000],
  ["nam-dinh", "Nam Định", 20.4342, 106.1773, 2, "Nam Định", 350000],
  ["pleiku", "Pleiku", 13.9833, 108.0, 2, "Gia Lai", 200000],
  ["phan-thiet", "Phan Thiết", 10.9333, 108.1, 2, "Bình Thuận", 220000],
  ["ha-giang", "Hà Giang", 22.8233, 104.9836, 3, "Hà Giang", 55000],
  ["cao-bang", "Cao Bằng", 22.666, 106.258, 3, "Cao Bằng", 73000],
  ["lang-son", "Lạng Sơn", 21.8537, 106.7615, 3, "Lạng Sơn", 200000],
  ["lao-cai", "Lào Cai", 22.4809, 103.9755, 3, "Lào Cai", 130000],
  ["dien-bien", "Điện Biên Phủ", 21.386, 103.023, 3, "Điện Biên", 90000],
  ["son-la", "Sơn La", 21.327, 103.918, 3, "Sơn La", 120000],
  ["ninh-binh", "Ninh Bình", 20.2506, 105.9745, 3, "Ninh Bình", 160000],
  ["dong-hoi", "Đồng Hới", 17.4689, 106.6223, 3, "Quảng Bình", 130000],
  ["ca-mau", "Cà Mau", 9.1768, 105.1524, 3, "Cà Mau", 130000],
  ["phu-quoc", "Phú Quốc", 10.2899, 103.984, 3, "Kiên Giang", 180000],
  ["hoi-an", "Hội An", 15.8801, 108.338, 3, "Quảng Nam", 90000],
  ["tam-ky", "Tam Kỳ", 15.5736, 108.4741, 3, "Quảng Nam", 120000],
  ["quang-ngai", "Quảng Ngãi", 15.1205, 108.7922, 3, "Quảng Ngãi", 130000],
  ["tuy-hoa", "Tuy Hòa", 13.0955, 109.3208, 3, "Phú Yên", 120000],
  ["kon-tum", "Kon Tum", 14.3545, 108.0076, 3, "Kon Tum", 100000],
  ["rach-gia", "Rạch Giá", 10.0125, 105.0809, 3, "Kiên Giang", 250000],
  ["my-tho", "Mỹ Tho", 10.36, 106.36, 3, "Tiền Giang", 220000],
  ["long-xuyen", "Long Xuyên", 10.3864, 105.4352, 3, "An Giang", 280000],
  ["bac-lieu", "Bạc Liêu", 9.2941, 105.7278, 3, "Bạc Liêu", 150000],
  ["soc-trang", "Sóc Trăng", 9.6025, 105.9739, 3, "Sóc Trăng", 160000],
  ["tra-vinh", "Trà Vinh", 9.9477, 106.342, 3, "Trà Vinh", 130000],
  ["ben-tre", "Bến Tre", 10.2333, 106.3833, 3, "Bến Tre", 130000],
  ["thu-dau-mot", "Thủ Dầu Một", 10.9804, 106.6519, 3, "Bình Dương", 300000],
  ["tan-an", "Tân An", 10.5333, 106.4167, 3, "Long An", 120000],
  ["chau-doc", "Châu Đốc", 10.7, 105.1167, 4, "An Giang", 100000],
  ["sa-pa", "Sa Pa", 22.3364, 103.8438, 4, "Lào Cai", 15000],
  ["tuyen-quang", "Tuyên Quang", 21.8236, 105.2181, 4, "Tuyên Quang", 70000],
  ["yen-bai", "Yên Bái", 21.7059, 104.8711, 4, "Yên Bái", 80000],
  ["viet-tri", "Việt Trì", 21.3022, 105.4008, 4, "Phú Thọ", 180000],
  ["hoa-binh", "Hòa Bình", 20.8172, 105.3378, 4, "Hòa Bình", 90000],
  ["bac-ninh", "Bắc Ninh", 21.1861, 106.0763, 4, "Bắc Ninh", 200000],
  ["hai-duong", "Hải Dương", 20.9373, 106.3145, 4, "Hải Dương", 240000],
  ["thai-binh", "Thái Bình", 20.4499, 106.34, 4, "Thái Bình", 180000],
  ["phu-ly", "Phủ Lý", 20.5411, 105.9139, 4, "Hà Nam", 100000],
  ["ha-tinh", "Hà Tĩnh", 18.3428, 105.9058, 4, "Hà Tĩnh", 130000],
  ["quang-tri", "Đông Hà", 16.8163, 107.1003, 4, "Quảng Trị", 80000],
  ["phan-rang", "Phan Rang-Tháp Chàm", 11.5644, 108.9886, 4, "Ninh Thuận", 160000],
  ["cam-ranh", "Cam Ranh", 11.9136, 109.1361, 4, "Khánh Hòa", 150000],
  ["bao-loc", "Bảo Lộc", 11.5475, 107.8075, 4, "Lâm Đồng", 170000],
  ["dong-xoai", "Đồng Xoài", 11.5333, 106.9, 4, "Bình Phước", 90000],
  ["tay-ninh", "Tây Ninh", 11.3167, 106.1, 4, "Tây Ninh", 130000],
  ["vinh-long", "Vĩnh Long", 10.2537, 105.9722, 4, "Vĩnh Long", 150000],
  ["soc-son", "Sóc Sơn", 21.2589, 105.8481, 4, "Hà Nội", 340000],
];

export const DEFAULT_PLACES: Place[] = RAW_PLACES.map(
  ([id, name, lat, lon, rank, admin, population]) => ({
    id,
    name,
    lat,
    lon,
    rank,
    admin,
    population,
  }),
);