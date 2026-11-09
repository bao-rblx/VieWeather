# VieWeather — UI Integration Contract

Every module below is OWNED by exactly one author. Do not edit files outside your scope.
The Lead owns `src/App.tsx`, `src/types.ts`, `src/styles.css`, `src/windy.css`, `src/main.tsx`.

## Design language (must match existing app)

```
--ink:    #eaf2f4   (primary text)
--muted:  #a7bac5   (secondary text)
--glass:  rgba(18, 34, 48, 0.91)   (panel fill)
--line:   rgba(205, 225, 235, 0.12) (hairline)
--accent: #f4bd5d   (amber, actions/highlight)
--ocean:  #183f57   (backdrop)
alert/orange: #d96c4e   success: #8fcaab   cool: #8dbdd7
```

Fonts already loaded: **Manrope** (display/headings, weights 400–800) and **DM Sans** (body/UI).
Radii: cards 12px, controls 8px, pills 999px. Text sizes are small: mini-label 9px / 1.6px letter-spacing,
body 11–12px, headings 16–26px.
Motion feel: **soft, fluid, premium** — cubic-bezier(.22,1,.36,1) for entrances,
never linear, never bouncy-plastic. Respect `prefers-reduced-motion`.

## src/motion.tsx  (owner: motion)

Exports — names and signatures are FIXED:

```tsx
// Animated numeric counter. Mentally interpolates from previous value to next.
export function AnimatedNumber(props: {
  value: number; decimals?: number; duration?: number; className?: string;
}): JSX.Element;

// Enters children with a fade+rise when it scrolls into view or mounts.
export function Reveal(props: {
  children: React.ReactNode; delay?: number; y?: number; className?: string;
  as?: "div" | "section" | "li" | "tr"; once?: boolean;
}): JSX.Element;

// Staggers direct children reveals by index.
export function Stagger(props: {
  children: React.ReactNode; gap?: number; delay?: number; className?: string;
}): JSX.Element;

// Wraps the app; adds a click ripple + press-scale to every button/[role=button] inside.
export function InteractionLayer(props: { children: React.ReactNode }): JSX.Element;

// Programmatic ripple trigger for non-button surfaces.
export function ripple(event: React.MouseEvent | MouseEvent, host?: HTMLElement): void;

// spring/tween helper for imperative animation (canvas, map camera)
export function tween(opts: {
  from: number; to: number; duration: number;
  ease?: (t: number) => number;
  onUpdate: (v: number) => void;
  onDone?: () => void;
}): () => void;

export const easeOutCubic: (t: number) => number;
export const easeInOutCubic: (t: number) => number;
export const rgba: (hex: string, alpha: number) => string;
```

## src/Ambient.tsx  (owner: motion)

```tsx
// Full-bleed canvas weather ambience behind the UI, above the map.
// Reacts to the condition code + day/night + wind. Particles: rain streaks,
// snow drift, fog haze, drifting clouds, sun shafts, night stars, lightning flashes.
export function Ambient(props: {
  code: number;        // WMO weather code of the focused city
  isDay: boolean;
  wind: number;        // km/h
  intensity?: number;  // 0..1, default 1
  reduce?: boolean;    // force off
}): JSX.Element;
```

Ambient must be `position:absolute; inset:0; pointer-events:none;` and cheap (rAF-throttled,
density scaled to viewport, devicePixelRatio aware). It must not allocate per frame.

## src/WeatherMap.tsx  (owner: map)

```tsx
export type MapMode = "dark" | "satellite" | "terrain";  // re-export from ./types

export default function WeatherMap(props: {
  weather: Weather[];
  selected: string;
  onSelect: (id: string) => void;
  metric: Metric;
  hour: number;
  fahrenheit: boolean;
  particles: boolean;
  mode: MapMode;              // NEW: basemap presentation
  threeD: boolean;            // NEW: pitched + extruded 3D view
  onModeChange: (m: MapMode) => void;  // NEW: map reports its own toolbar picks
}): JSX.Element;
```

Requirements:
- `satellite`: Esri World Imagery raster (`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`), naturally desaturated at low opacity under the weather field.
- `terrain`: Terrarium DEM (`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`) with `encoding:"terrarium"`, plus hillshade.
- `threeD`: real `setTerrain` relief, pitch ~55, and data-driven 3D weather columns (temperature/rain/wind bars) rising from each city. Toggling must animate the camera, not snap.
- Mode changes must crossfade (no white flash).
- Keep the existing city markers, wind particles, labels, scale legend and reset behaviour working.
- Expose the in-map mode switcher so the Lead does not need to duplicate it.

## src/Panels.tsx  (owner: panels)

```tsx
export function SunArc(props: { sun: SunTimes; isDay: boolean }): JSX.Element;
export function HourlyChart(props: {
  hourly: Hour[]; hour: number; fahrenheit: boolean; metric: Metric;
  onScrub: (hour: number) => void;
}): JSX.Element;   // SVG line/area chart, animated path draw, draggable cursor
export function AirQualityCard(props: { aq: AirQuality; compact?: boolean }): JSX.Element;
export function MoonCard(props: { moon: MoonPhase }): JSX.Element;
export function AlertStack(props: { alerts: WeatherAlert[]; onDismiss: (id: string) => void }): JSX.Element;
export function DetailGrid(props: {
  current: Weather["current"]; fahrenheit: boolean;
}): JSX.Element;   // pressure / visibility / dew point / UV / gust / cloud
export function CommandPalette(props: {
  weather: Weather[]; open: boolean; onClose: () => void;
  onPick: (cityId: string) => void;
}): JSX.Element;   // ⌘K search overlay, keyboard driven
```

## backend  (owner: backend)

Extend `backend/weather.py` + `backend/main.py`:
- `Weather` gains `airQuality`, `sun`, `moon`, `alerts`, and `current.uvIndex/dewPoint/visibility/windGust`.
- New endpoints: `GET /api/air-quality/{city_id}`, `GET /api/cities/search?q=`, `GET /api/alerts`.
- Live Open-Meteo `air_quality` endpoint merged into the collector; demo mode synthesises plausible values.
- Must keep `/api/weather`, `/api/analytics`, `/api/history/{id}`, `/api/export`, `/api/events`, `/api/health` backwards compatible.

## Verification

Dev server is already running at http://127.0.0.1:5173 (API on :8010).
Screenshot with:
```
node scripts/shoot.cjs '[]' mylabel
```
Options per step: `{"click":"selector"}`, `{"wait":800}`, `{"shot":"name"}`, `{"eval":"js"}`.
Screens land in `shots/`. Read them back with the read_image tool.
