# VieWeather — detailed map + dense data contract

Read docs/UI_CONTRACT.md first for the design language. This file adds the
detailed-basemap work.

## Problem being solved

1. The basemap has no place labels, no province/district boundaries and stops at
   zoom 10, so zooming in shows an empty raster. Users expect town/ward names in
   Vietnamese and province borders, like Windy.
2. The weather field was a blur of only 25 city readings (inverse-distance
   interpolation). Users expect a dense, spatially honest field and a
   temperature next to every place name.
3. Users compare numbers with Windy, which reads ECMWF. Our provider blend
   differs by ~1°C and by a lot on humidity, so the model must be visible and
   selectable.

## Confirmed-working sources (no API keys)

- **Vector basemap** OpenFreeMap / OpenMapTiles:
  `https://tiles.openfreemap.org/planet` (TileJSON root; MapLibre accepts it directly as
  `{ type: "vector", url: "https://tiles.openfreemap.org/planet" }`).
  Glyphs: `https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf` — the fontstack used by
  the reference style is `"Noto Sans Regular"`; check a few stacks and fall back gracefully.
  Source layers available: `place`, `boundary`, `transportation`, `transportation_name`,
  `water`, `waterway`, `water_name`, `landcover`, `landuse`, `park`, `building`, `poi`,
  `aeroway`, `aerodrome_label`.
  Place classes in the `place` layer: `country | state | city | town | village`.
  Fields include `name`, `name:vi`, `name:latin`, `name_en`, `class`, `rank`, `capital`.
  Boundaries: `boundary` layer has `admin_level` (2 = country, 4 = province, 6 = district).
- **Satellite**: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`
- **Relief**: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Physical_Map/MapServer/tile/{z}/{y}/{x}`
- **DEM**: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` (encoding: terrarium)
- **Dense field**: Open-Meteo accepts 300+ comma-separated coordinates in one request. Measured:
  20×16 = 320 points returned in 0.6 s.

Vietnamese labels: prefer `name:vi`, then `name`, then `name_en`.

## New shared types (already in src/types.ts — do not edit)

```ts
type FieldPoint = { lat; lon; temperature; precipitation; wind; windDirection; code; isDay; humidity };
type Field = { model; observedAt; fetchedAt; stale; cols; rows; bounds: [W,S,E,N]; points: FieldPoint[] };
type Place = { id; name; lat; lon; rank; admin; population };
const WEATHER_MODELS: { id; label; detail }[]; // ecmwf_ifs025 | best_match | icon_seamless | gfs_seamless
```

## Backend endpoints (owner: grid)

`GET /api/field?model=<id>` ->
`{ model, observedAt, fetchedAt, stale, cols, rows, bounds:[w,s,e,n],
   points:[{lat,lon,temperature,precipitation,wind,windDirection,code,isDay,humidity}] }`
- Sample a regular grid across Vietnam: lon 102.0..109.8, lat 8.6..23.4, about 26 cols × 22 rows
  (≈570 points). One batched Open-Meteo call; split into several calls if one is too large.
- Cache in memory for 10 minutes (the collector already polls every 10 min — reuse its cadence).
- `model` defaults to `ecmwf_ifs025`. Unknown model -> 400.
- If the provider fails, serve the last good grid with `stale: true`; never 500.

`GET /api/places` -> `Place[]` (rank 1..4, sorted by rank then population desc)
`GET /api/models` -> `[{id,label,detail}]`

## Map work (owner: basemap)

`src/WeatherMap.tsx` gains props:
```ts
field?: Field | null;
places?: Place[];
model?: string;
```
and keeps `mode / threeD / onModeChange / onThreeDChange`.

Requirements:
- **Vector basemap** replaces the flat raster for all three modes, with Vietnamese place labels:
  - dark: deep desaturated blue-grey land/water that matches the app, roads subtle, borders visible
  - satellite: Esri imagery underneath + vector labels/borders/roads on top (text only, no fills)
  - terrain: Esri relief + DEM hillshade + vector labels/borders
- Labels must include `name:vi`, sized by class, with halo for legibility; country / state / city / town /
  village progressive appearance by zoom. maxZoom 14-15 so zooming in actually reveals detail.
- Admin boundaries: country (admin_level 2) strong, province (4) medium, district (6) faint at high zoom.
- Roads scale in by zoom; building footprints optional at z >= 14.
- **Temperature labels at places** (the headline feature): a symbol layer over `places` showing
  `name` + `temp°`, filtered by `rank` per zoom so density grows as you zoom in and never clutters:
  rank 1 at low zoom, then 2, 3, 4. Temperature computed client-side from `field` by bilinear
  interpolation and written into the GeoJSON properties whenever the field or units change.
- **Field rendering** uses `field.points` (bilinear/bicubic resampling) instead of the 25-city IDW.
  Keep `makeWeatherImage` and `sampleWind` working but drive them from the grid. Wind particles read
  wind from the grid.
- Keep 3D terrain, weather columns, city markers, legend, reset, reduced-motion behaviour.

## Accuracy handling (owner: grid + lead)

- Default model becomes `ecmwf_ifs025` so the app agrees with Windy, which reads ECMWF.
- Every payload carries its `model`; the UI shows the active model name so the number is traceable.
- Document measured agreement.
