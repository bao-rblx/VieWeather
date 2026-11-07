import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import {
  type ExpressionSpecification,
  type ImageSource,
  type LayerSpecification,
  type StyleSpecification,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./map.css";
import {
  Compass,
  Minus,
  Plus,
  Maximize2,
  Moon,
  Satellite,
  Mountain,
  Box,
} from "lucide-react";
import {
  type Weather,
  type Metric,
  type MapMode,
  type Field,
  type Place,
  WEATHER_MODELS,
  temperature,
} from "./types";
import {
  renderWeatherCanvas,
  createSampler,
  buildPlaceGeoJSON,
  synthesizeField,
  weatherImageCoordinates,
  scales,
  DEFAULT_PLACES,
  blankImage,
} from "./weatherField";
maplibregl.setWorkerUrl(workerUrl);

export type { MapMode } from "./types";

/* ------------------------------------------------------------------ sources */

const VT = "openmaptiles";
const VECTOR_URL = "https://tiles.openfreemap.org/planet";
const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
const SATELLITE_TILES =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const RELIEF_TILES =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Physical_Map/MapServer/tile/{z}/{y}/{x}";
const DEM_TILES =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

// The view has to cover the Hoang Sa and Truong Sa archipelagos, which lie well
// east of the mainland coast (111.6 E and 111.9 E), so the fitted extent reaches
// past 114 E. The east bound is deliberately generous: the legend and the map
// controls sit on the right edge of the stage, and without the margin the island
// markers fall underneath them.
const FIT_BOUNDS: [[number, number], [number, number]] = [
  [101.0, 7.2],
  [117.6, 24.2],
];

// Padding keeps the fitted country clear of the floating panels: the location card
// on the left and the layer/legend stack on the right. The right value has to cover
// the map controls, the temperature legend and the island markers east of the coast.
const VIEW_PADDING = () =>
  window.innerWidth > 700
    ? { top: 55, bottom: 35, left: 330, right: 330 }
    : { top: 70, bottom: 30, left: 30, right: 30 };

/** Vietnamese label first, then the default OSM name, then English. */
const nameVi = [
  "coalesce",
  ["get", "name:vi"],
  ["get", "name"],
  ["get", "name_en"],
] as unknown as ExpressionSpecification;

const TEMP_TEXT = [
  "case",
  ["==", ["get", "value"], ""],
  ["get", "name"],
  [
    "format",
    ["get", "name"],
    { "font-scale": 0.84 },
    "\n",
    {},
    ["get", "value"],
    {
      "font-scale": 1.22,
      "text-font": ["literal", ["Noto Sans Bold"]],
      "text-color": "#f8cf8b",
    },
    ["get", "unit"],
    { "font-scale": 0.74, "text-color": "#e8c184" },
  ],
] as unknown as ExpressionSpecification;

const notTunnel: ExpressionSpecification = [
  "match",
  ["get", "brunnel"],
  ["bridge", "tunnel"],
  false,
  true,
];

const roadClasses = (classes: string[]): ExpressionSpecification => [
  "all",
  notTunnel,
  ["match", ["get", "class"], classes, true, false],
];

/* ------------------------------------------------------------------- themes */

type Theme = {
  bg: string;
  satOpacity: number;
  physicalOpacity: number;
  landFill: number;
  water: string;
  waterOpacity: number;
  green: string;
  greenOpacity: number;
  built: string;
  builtOpacity: number;
  roadCasing: string;
  roadMajor: string;
  roadMid: string;
  roadMinor: string;
  roadMajorOpacity: number;
  roadMidOpacity: number;
  roadMinorOpacity: number;
  building: string;
  buildingOpacity: number;
  countryLine: string;
  countryOpacity: number;
  provinceLine: string;
  provinceOpacity: number;
  districtLine: string;
  districtOpacity: number;
  placeText: string;
  placeHalo: string;
  regionText: string;
  countryText: string;
  waterText: string;
  roadText: string;
  satSaturation: number;
  physSaturation: number;
};

const DARK: Theme = {
  bg: "#1b2d38",
  satOpacity: 0,
  physicalOpacity: 0,
  landFill: 0,
  water: "#102330",
  waterOpacity: 1,
  green: "#20342f",
  greenOpacity: 0.45,
  built: "#18262f",
  builtOpacity: 0.45,
  roadCasing: "#0c1921",
  roadMajor: "#a3bcc6",
  roadMid: "#87a1ac",
  roadMinor: "#6b8591",
  roadMajorOpacity: 0.95,
  roadMidOpacity: 0.88,
  roadMinorOpacity: 0.8,
  building: "#1d2b34",
  buildingOpacity: 0.5,
  countryLine: "#c3dae3",
  countryOpacity: 0.7,
  provinceLine: "#a3c3cf",
  provinceOpacity: 0.52,
  districtLine: "#8db0bd",
  districtOpacity: 0.38,
  placeText: "#e9f4f8",
  placeHalo: "#06141d",
  regionText: "#aac7d3",
  countryText: "#d8e9f0",
  waterText: "#7fa9bb",
  roadText: "#93adb8",
  satSaturation: -0.2,
  physSaturation: -0.32,
};

const SAT: Theme = {
  ...DARK,
  bg: "#0b141a",
  satOpacity: 0.94,
  landFill: 0,
  waterOpacity: 0,
  greenOpacity: 0,
  builtOpacity: 0,
  roadCasing: "#12100c",
  roadMajor: "#f6e9c9",
  roadMid: "#eddcb8",
  roadMinor: "#eddcb8",
  roadMajorOpacity: 0.34,
  roadMidOpacity: 0.2,
  roadMinorOpacity: 0.12,
  buildingOpacity: 0,
  countryLine: "#f4f9fb",
  countryOpacity: 0.45,
  provinceLine: "#e8f0f2",
  provinceOpacity: 0.22,
  districtLine: "#e8f0f2",
  districtOpacity: 0.13,
  placeText: "#ffffff",
  placeHalo: "#02101a",
  regionText: "#eaf3f6",
  countryText: "#ffffff",
  waterText: "#d2e8f1",
  roadText: "#f2e7cb",
  satSaturation: -0.1,
};

const TER: Theme = {
  ...DARK,
  bg: "#0c1a22",
  physicalOpacity: 0.82,
  landFill: 0,
  water: "#123040",
  waterOpacity: 0.4,
  greenOpacity: 0.12,
  builtOpacity: 0.2,
  roadCasing: "#0e1c24",
  roadMajor: "#93a7ac",
  roadMid: "#7e9399",
  roadMinor: "#6d8289",
  roadMajorOpacity: 0.5,
  roadMidOpacity: 0.4,
  roadMinorOpacity: 0.28,
  building: "#3d4d51",
  buildingOpacity: 0.2,
  countryLine: "#dfeaee",
  countryOpacity: 0.45,
  provinceLine: "#c8dade",
  provinceOpacity: 0.26,
  districtLine: "#c8dade",
  districtOpacity: 0.15,
  placeText: "#f5fbfd",
  placeHalo: "#08171e",
  regionText: "#d0e1e7",
  countryText: "#eff8fa",
  waterText: "#aacbd9",
  roadText: "#c1d2d7",
  physSaturation: -0.3,
};

const THEMES: Record<MapMode, Theme> = {
  dark: DARK,
  satellite: SAT,
  terrain: TER,
};

/**
 * Field opacity as a plain number. A zoom-interpolated expression on
 * raster-opacity stops the layer re-sorting correctly over the vector layers at
 * high zoom (the basemap vanishes), so the value is computed here and refreshed
 * on zoomend instead.
 */
function fieldOpacity(mode: MapMode, threeD: boolean, zoom: number) {
  const base = threeD ? 0.36 : mode === "satellite" ? 0.46 : mode === "terrain" ? 0.54 : 0.53;
  const taper = Math.max(0, Math.min(1, (zoom - 7) / 6));
  return base - taper * 0.16;
}

/* -------------------------------------------------------------------- style */

const layout = (extra: Record<string, unknown>) => extra as never;

function buildStyle(): StyleSpecification {
  const layers: LayerSpecification[] = [
    { id: "bg", type: "background", paint: { "background-color": DARK.bg } },
    {
      id: "satellite",
      type: "raster",
      source: "satellite",
      paint: {
        "raster-opacity": 0,
        "raster-fade-duration": 0,
        "raster-saturation": -0.1,
        "raster-contrast": 0.06,
        "raster-brightness-max": 0.94,
      },
    },
    {
      id: "physical",
      type: "raster",
      source: "physical",
      paint: {
        "raster-opacity": 0,
        "raster-fade-duration": 0,
        "raster-saturation": -0.32,
        "raster-brightness-max": 0.82,
      },
    },
    {
      id: "vt-water",
      type: "fill",
      source: VT,
      "source-layer": "water",
      filter: ["!=", ["get", "brunnel"], "tunnel"] as never,
      paint: { "fill-color": DARK.water, "fill-opacity": 1 },
    },
    {
      id: "vt-green",
      type: "fill",
      source: VT,
      "source-layer": "landcover",
      filter: [
        "match",
        ["get", "class"],
        ["wood", "grass", "scrub", "forest"],
        true,
        false,
      ] as never,
      paint: { "fill-color": DARK.green, "fill-opacity": 0.4 },
    },
    {
      id: "vt-park",
      type: "fill",
      source: VT,
      "source-layer": "park",
      paint: { "fill-color": "#1d332d", "fill-opacity": 0.28 },
    },
    {
      id: "vt-built",
      type: "fill",
      source: VT,
      "source-layer": "landuse",
      filter: [
        "match",
        ["get", "class"],
        ["residential", "commercial", "industrial", "suburb"],
        true,
        false,
      ] as never,
      paint: { "fill-color": DARK.built, "fill-opacity": 0.45 },
    },
    {
      id: "land",
      type: "fill",
      source: "land",
      paint: { "fill-color": "#365860", "fill-opacity": 0 },
    },
    {
      id: "land-borders",
      type: "line",
      source: "land",
      layout: { visibility: "none" },
      paint: { "line-color": "#122e3c", "line-width": 1.1, "line-opacity": 0.7 },
    },
    {
      id: "land-coast",
      type: "line",
      source: "land",
      layout: { visibility: "none" },
      paint: { "line-color": "#9fc0cc", "line-width": 1, "line-opacity": 0.5 },
    },
    {
      id: "hillshade",
      type: "hillshade",
      source: "dem",
      layout: { visibility: "none" },
      paint: {
        "hillshade-shadow-color": "#08151f",
        "hillshade-highlight-color": "#d6e2dc",
        "hillshade-accent-color": "#0a1a26",
        "hillshade-exaggeration": 0.55,
      },
    },
    {
      id: "weather-field",
      type: "raster",
      source: "weather-field",
      paint: { "raster-opacity": 0, "raster-fade-duration": 0 },
    },
    {
      id: "vt-road-casing",
      type: "line",
      source: VT,
      "source-layer": "transportation",
      minzoom: 7,
      filter: roadClasses(["motorway", "trunk", "primary"]),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": DARK.roadCasing,
        "line-opacity": 0.55,
        "line-width": ["interpolate", ["linear"], ["zoom"], 7, 1.2, 11, 3, 15, 4.6],
      },
    },
    {
      id: "vt-road-major",
      type: "line",
      source: VT,
      "source-layer": "transportation",
      minzoom: 5.6,
      filter: roadClasses(["motorway", "trunk", "primary"]),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": DARK.roadMajor,
        "line-opacity": 0.85,
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 9, 1.3, 12, 2, 15, 3],
      },
    },
    {
      id: "vt-road-mid",
      type: "line",
      source: VT,
      "source-layer": "transportation",
      minzoom: 8.6,
      filter: roadClasses(["secondary", "tertiary"]),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": DARK.roadMid,
        "line-opacity": 0.7,
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.6, 12, 1.2, 15, 2],
      },
    },
    {
      id: "vt-road-minor",
      type: "line",
      source: VT,
      "source-layer": "transportation",
      minzoom: 11.4,
      filter: roadClasses(["minor", "street", "service"]),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": DARK.roadMinor,
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 11.4, 0, 12.4, 0.6],
        "line-width": ["interpolate", ["linear"], ["zoom"], 11.4, 0.4, 15, 1.6],
      },
    },
    {
      id: "vt-building",
      type: "fill",
      source: VT,
      "source-layer": "building",
      minzoom: 13.2,
      paint: {
        "fill-color": DARK.building,
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13.2, 0, 14, 0.5],
        "fill-outline-color": "rgba(0,0,0,0.22)",
      },
    },
    {
      id: "vt-b-district",
      type: "line",
      source: VT,
      "source-layer": "boundary",
      minzoom: 8,
      filter: [
        "all",
        ["==", ["get", "admin_level"], 6],
        ["!=", ["get", "maritime"], 1],
      ] as never,
      paint: {
        "line-color": DARK.districtLine,
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0, 10, 0.22],
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 12, 1.1, 15, 1.5],
        "line-dasharray": [3, 2],
      },
    },
    {
      id: "vt-b-province",
      type: "line",
      source: VT,
      "source-layer": "boundary",
      minzoom: 5,
      filter: [
        "all",
        ["==", ["get", "admin_level"], 4],
        ["!=", ["get", "maritime"], 1],
      ] as never,
      paint: {
        "line-color": DARK.provinceLine,
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.16, 8, 0.42],
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.6, 9, 1.2, 15, 2.1],
      },
    },
    {
      id: "vt-b-country",
      type: "line",
      source: VT,
      "source-layer": "boundary",
      filter: [
        "all",
        ["==", ["get", "admin_level"], 2],
        ["!=", ["get", "maritime"], 1],
      ] as never,
      paint: {
        "line-color": DARK.countryLine,
        "line-opacity": DARK.countryOpacity,
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1, 6, 1.3, 10, 2, 15, 2.8],
      },
    },
    {
      id: "column-glow",
      type: "circle",
      source: "column-points",
      layout: { visibility: "none" },
      paint: {
        "circle-color": ["get", "color"] as never,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 12, 6, 20, 8, 34] as never,
        "circle-blur": 1,
        "circle-opacity": 0.32,
      },
    },
    {
      id: "weather-columns",
      type: "fill-extrusion",
      source: "weather-columns",
      layout: { visibility: "none" },
      paint: {
        "fill-extrusion-color": ["get", "color"] as never,
        "fill-extrusion-height": ["get", "height"] as never,
        "fill-extrusion-base": ["get", "base"] as never,
        "fill-extrusion-opacity": 0.95,
        "fill-extrusion-vertical-gradient": false,
      },
    },
    {
      id: "temp-rank-1",
      type: "symbol",
      source: "places",
      minzoom: 3.4,
      filter: ["==", ["get", "rank"], 1] as never,
      layout: layout({
        "text-field": TEMP_TEXT,
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 4, 11, 7, 13, 11, 15] as never,
        "text-line-height": 0.92,
        "text-max-width": 9,
        "text-variable-anchor": ["top", "bottom"] as never,
        "text-padding": 3,
        "text-allow-overlap": false,
        "text-ignore-placement": false,
        "symbol-sort-key": ["get", "sortKey"] as never,
      }),
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "rgba(4,16,24,0.92)",
        "text-halo-width": 2.4,
        "text-halo-blur": 0.7,
      },
    },
    {
      id: "temp-rank-2",
      type: "symbol",
      source: "places",
      minzoom: 4.2,
      filter: ["==", ["get", "rank"], 2] as never,
      layout: layout({
        "text-field": TEMP_TEXT,
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 4.2, 9.5, 8, 11, 12, 13.5] as never,
        "text-line-height": 0.92,
        "text-max-width": 8,
        "text-variable-anchor": ["top", "bottom"] as never,
        "text-padding": 2,
        "text-allow-overlap": false,
        "text-ignore-placement": false,
        "symbol-sort-key": ["get", "sortKey"] as never,
      }),
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "rgba(4,16,24,0.9)",
        "text-halo-width": 2.2,
        "text-halo-blur": 0.7,
      },
    },
    {
      id: "temp-rank-3",
      type: "symbol",
      source: "places",
      minzoom: 7,
      filter: ["==", ["get", "rank"], 3] as never,
      layout: layout({
        "text-field": TEMP_TEXT,
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 7, 9.5, 10, 10.5, 13, 12] as never,
        "text-line-height": 0.92,
        "text-max-width": 8,
        "text-variable-anchor": ["top", "bottom"] as never,
        "text-padding": 2,
        "text-allow-overlap": false,
        "text-ignore-placement": false,
        "symbol-sort-key": ["get", "sortKey"] as never,
      }),
      paint: {
        "text-color": "#f2f9fb",
        "text-halo-color": "rgba(4,16,24,0.9)",
        "text-halo-width": 2,
        "text-halo-blur": 0.7,
      },
    },
    {
      id: "temp-rank-4",
      type: "symbol",
      source: "places",
      minzoom: 9.5,
      filter: ["==", ["get", "rank"], 4] as never,
      layout: layout({
        "text-field": TEMP_TEXT,
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 9.6, 9.5, 14, 11] as never,
        "text-line-height": 0.92,
        "text-max-width": 8,
        "text-anchor": "top",
        "text-offset": [0, 0.4] as never,
        "text-padding": 1.5,
        "text-allow-overlap": false,
        "text-ignore-placement": false,
        "symbol-sort-key": ["get", "sortKey"] as never,
      }),
      paint: {
        "text-color": "#e6f1f5",
        "text-halo-color": "rgba(4,16,24,0.9)",
        "text-halo-width": 1.9,
        "text-halo-blur": 0.7,
      },
    },
    {
      id: "vt-place-country",
      type: "symbol",
      source: VT,
      "source-layer": "place",
      maxzoom: 8.5,
      filter: ["==", ["get", "class"], "country"] as never,
      layout: layout({
        "text-field": nameVi,
        "text-font": ["Noto Sans Bold"],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.14,
        "text-size": ["interpolate", ["linear"], ["zoom"], 3, 9, 6, 13, 8, 16] as never,
        "text-max-width": 7,
      }),
      paint: {
        "text-color": DARK.countryText,
        "text-halo-color": DARK.placeHalo,
        "text-halo-width": 1.1,
        "text-opacity": ["interpolate", ["linear"], ["zoom"], 7.5, 0.9, 8.5, 0.2],
      },
    },
    {
      id: "vt-place-region",
      type: "symbol",
      source: VT,
      "source-layer": "place",
      minzoom: 4.5,
      maxzoom: 11,
      filter: ["==", ["get", "class"], "state"] as never,
      layout: layout({
        "text-field": nameVi,
        "text-font": ["Noto Sans Regular"],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.18,
        "text-size": ["interpolate", ["linear"], ["zoom"], 5, 8, 8, 10.5] as never,
        "text-max-width": 8,
      }),
      paint: {
        "text-color": DARK.regionText,
        "text-halo-color": DARK.placeHalo,
        "text-halo-width": 1,
        "text-opacity": ["interpolate", ["linear"], ["zoom"], 4.5, 0, 6, 0.5, 9.5, 0.42, 11, 0],
      },
    },
    {
      id: "vt-place-detail",
      type: "symbol",
      source: VT,
      "source-layer": "place",
      minzoom: 11.5,
      filter: [
        "match",
        ["get", "class"],
        ["village", "hamlet", "suburb", "quarter", "neighbourhood"],
        true,
        false,
      ] as never,
      layout: layout({
        "text-field": nameVi,
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 11.5, 9, 14, 11] as never,
        "text-max-width": 8,
        "text-anchor": "top",
        "text-offset": [0, 0.3] as never,
        "text-padding": 2,
        "text-allow-overlap": false,
        "text-ignore-placement": false,
      }),
      paint: {
        "text-color": "#cfe0e7",
        "text-halo-color": DARK.placeHalo,
        "text-halo-width": 1.4,
        "text-halo-blur": 0.4,
        "text-opacity": ["interpolate", ["linear"], ["zoom"], 11.5, 0, 12.3, 0.8],
      },
    },
    {
      id: "vt-road-label",
      type: "symbol",
      source: VT,
      "source-layer": "transportation_name",
      minzoom: 11.5,
      filter: [
        "match",
        ["get", "class"],
        ["primary", "secondary", "tertiary", "trunk"],
        true,
        false,
      ] as never,
      layout: layout({
        "symbol-placement": "line",
        "text-field": nameVi,
        "text-font": ["Noto Sans Regular"],
        "text-rotation-alignment": "map",
        "text-size": ["interpolate", ["linear"], ["zoom"], 11.5, 9, 14, 10.5] as never,
        "text-letter-spacing": 0.02,
        "text-padding": 4,
      }),
      paint: {
        "text-color": DARK.roadText,
        "text-halo-color": DARK.placeHalo,
        "text-halo-width": 1.2,
        "text-opacity": ["interpolate", ["linear"], ["zoom"], 11.5, 0, 12.5, 0.75],
      },
    },
    {
      id: "vt-water-name",
      type: "symbol",
      source: VT,
      "source-layer": "water_name",
      minzoom: 4,
      layout: layout({
        "text-field": nameVi,
        "text-font": ["Noto Sans Italic"],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.28,
        "text-size": ["interpolate", ["linear"], ["zoom"], 4, 9, 8, 12] as never,
        "text-max-width": 9,
        "text-padding": 3,
      }),
      paint: {
        "text-color": DARK.waterText,
        "text-halo-color": "rgba(6,20,29,0.45)",
        "text-halo-width": 1,
        "text-opacity": 0.75,
      },
    },
  ];

  // Symbol collision priority follows layer order, so the place + temperature
  // labels are moved to the very end: a name+temperature always wins over a
  // province or sea name. Nothing else in the style draws city names now.
  const tempIds = ["temp-rank-1", "temp-rank-2", "temp-rank-3", "temp-rank-4"];
  const drawnFirst = layers.filter((layer) => !tempIds.includes(layer.id));
  const labels = layers
    .filter((layer) => tempIds.includes(layer.id))
    .reverse(); // rank 1 is drawn last, so it wins collisions
  const orderedLayers = drawnFirst.concat(labels);

  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      [VT]: {
        type: "vector",
        url: VECTOR_URL,
        attribution:
          '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
      },
      land: { type: "geojson", data: "/asia.geojson" },
      satellite: {
        type: "raster",
        tiles: [SATELLITE_TILES],
        tileSize: 256,
        maxzoom: 19,
        attribution: "Imagery (c) Esri, Maxar, Earthstar Geographics",
      },
      physical: {
        type: "raster",
        tiles: [RELIEF_TILES],
        tileSize: 256,
        maxzoom: 8,
        attribution: "Tiles (c) Esri",
      },
      dem: {
        type: "raster-dem",
        tiles: [DEM_TILES],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 13,
      },
      "terrain-dem": {
        type: "raster-dem",
        tiles: [DEM_TILES],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 13,
      },
      "weather-field": {
        type: "image",
        url: blankImage,
        coordinates: weatherImageCoordinates(null),
      },
      places: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      },
      "weather-columns": {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      },
      "column-points": {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      },
    },
    layers: orderedLayers,
  };
}

/* ------------------------------------------------------------- 3D geo helpers */

type ColumnCity = {
  id: string;
  lon: number;
  lat: number;
  rings: [number, number][][];
};

function ring(lon: number, lat: number, radiusDeg: number): [number, number][] {
  const out: [number, number][] = [];
  const rLon = radiusDeg / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    out.push([lon + Math.cos(a) * rLon, lat + Math.sin(a) * radiusDeg]);
  }
  out.push(out[0]);
  return out;
}

const SLICES = 22;
const BASE_RADIUS = 0.12;
const TAPER = 0.34;

function buildRings(lon: number, lat: number): [number, number][][] {
  const rings: [number, number][][] = [];
  for (let i = 0; i < SLICES; i++) {
    const t = i / (SLICES - 1);
    const r = BASE_RADIUS * (1 - (1 - TAPER) * t);
    rings.push(ring(lon, lat, r));
  }
  return rings;
}

function columnColor(value: number, metric: Metric): string {
  const stops = scales[metric];
  let rgb = stops[stops.length - 1][1];
  for (let i = 1; i < stops.length; i++) {
    if (value <= stops[i][0]) {
      const lo = stops[i - 1][0];
      const loC = stops[i - 1][1];
      const hi = stops[i][0];
      const hiC = stops[i][1];
      const r = Math.max(0, Math.min(1, (value - lo) / (hi - lo || 1)));
      rgb = loC.map((c, j) => Math.round(c + (hiC[j] - c) * r));
      break;
    }
  }
  const b = rgb.map((c) => Math.min(255, Math.round(c * 1.08 + 22)));
  return "rgb(" + b[0] + "," + b[1] + "," + b[2] + ")";
}

function columnHeight(value: number, metric: Metric): number {
  if (metric === "temperature") {
    const f = Math.max(0, Math.min(1, (value - 12) / 28));
    return 24000 + f * 160000;
  }
  if (metric === "wind") {
    const f = Math.max(0, Math.min(1, value / 48));
    return 20000 + f * 165000;
  }
  const f = Math.max(0, Math.min(1, value / 12));
  return 10000 + f * 160000;
}

/* ---------------------------------------------------------------- component */

export default function WeatherMap({
  weather,
  selected,
  onSelect,
  metric,
  hour,
  fahrenheit,
  particles,
  mode: modeProp,
  threeD: threeDProp,
  onModeChange,
  onThreeDChange,
  field,
  places: placesProp,
  model: modelProp,
}: {
  weather: Weather[];
  selected: string;
  onSelect: (id: string) => void;
  metric: Metric;
  hour: number;
  fahrenheit: boolean;
  particles: boolean;
  mode?: MapMode;
  threeD?: boolean;
  onModeChange?: (m: MapMode) => void;
  onThreeDChange?: (v: boolean) => void;
  /** Dense provider grid: the field raster and the temperature labels read it. */
  field?: Field | null;
  /** Vietnam gazetteer for the on-map place + temperature labels. */
  places?: Place[];
  /** Active forecast model id, surfaced on the legend. */
  model?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState("");
  const [vectorDown, setVectorDown] = useState(false);
  const [fetchedField, setFetchedField] = useState<Field | null>(null);
  const [fetchedPlaces, setFetchedPlaces] = useState<Place[] | null>(null);
  const [localMode, setLocalMode] = useState<MapMode>(modeProp ?? "dark");
  const [local3D, setLocal3D] = useState<boolean>(threeDProp ?? false);

  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const weatherRef = useRef(weather);
  weatherRef.current = weather;
  const lastSelected = useRef(selected);
  const columnsRef = useRef<ColumnCity[]>([]);
  const heightsRef = useRef<Map<string, number>>(new Map());
  const growRaf = useRef(0);
  const zoomBefore3D = useRef<number | null>(null);

  const mode = modeProp ?? localMode;
  const threeDControlled =
    threeDProp !== undefined && typeof onThreeDChange === "function";
  const threeD = threeDControlled ? (threeDProp as boolean) : local3D;
  const reduce =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function chooseMode(next: MapMode) {
    if (!modeProp) setLocalMode(next);
    onModeChange?.(next);
  }
  function toggleThreeD(next: boolean) {
    if (threeDControlled) onThreeDChange?.(next);
    else setLocal3D(next);
  }

  /* ---- data: fall back to our own fetch when the caller has no props ---- */

  useEffect(() => {
    if (field !== undefined) return;
    let cancelled = false;
    const load = () => {
      fetch("/api/field?model=" + encodeURIComponent(modelProp ?? "ecmwf_ifs025"))
        .then((r) => (r.ok ? r.json() : null))
        .then((json) => {
          if (!cancelled && json && Array.isArray(json.points) && json.points.length) {
            setFetchedField(json as Field);
          }
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 10 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [field, modelProp]);

  useEffect(() => {
    if (placesProp !== undefined) return;
    let cancelled = false;
    fetch("/api/places")
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!cancelled && Array.isArray(json) && json.length) {
          setFetchedPlaces(json as Place[]);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [placesProp]);

  /** Real grid when we have one, otherwise a grid synthesised from the cities. */
  const activeField = useMemo<Field | null>(() => {
    if (field) return field;
    if (field === undefined && fetchedField) return fetchedField;
    return synthesizeField(weather, 0);
  }, [field, fetchedField, weather]);

  const activePlaces = useMemo<Place[]>(() => {
    if (placesProp && placesProp.length) return placesProp;
    if (fetchedPlaces && fetchedPlaces.length) return fetchedPlaces;
    return DEFAULT_PLACES;
  }, [placesProp, fetchedPlaces]);

  const sampler = useMemo(
    () => createSampler(activeField, weather, hour),
    [activeField, weather, hour],
  );
  const samplerRef = useRef(sampler);
  samplerRef.current = sampler;

  // Guard against a silently flipped grid: in Vietnam the north is always
  // cooler than the Mekong delta, so this catches any row-order regression.
  useEffect(() => {
    if (!import.meta.env.DEV || !sampler.gridded) return;
    const north = sampler.value("temperature", 105.85, 21.03);
    const south = sampler.value("temperature", 105.78, 10.03);
    if (Number.isFinite(north) && Number.isFinite(south) && north > south) {
      console.warn(
        "[WeatherMap] grid orientation check failed: Hanoi " +
          north.toFixed(1) +
          "C is warmer than Can Tho " +
          south.toFixed(1) +
          "C - the field may be flipped.",
      );
    }
  }, [sampler]);

  const modelLabel = useMemo(() => {
    const id = modelProp ?? activeField?.model ?? "";
    if (!id) return "";
    return WEATHER_MODELS.find((m) => m.id === id)?.label ?? id;
  }, [modelProp, activeField]);

  const selectedCity = useMemo(
    () => weather.find((w) => w.city.id === selected)?.city,
    [weather, selected],
  );

  /* ------------------------------------------------------------- map boot */

  useEffect(() => {
    if (!container.current) return;
    let m: maplibregl.Map;
    try {
      m = new maplibregl.Map({
        container: container.current,
        style: buildStyle(),
        bounds: FIT_BOUNDS,
        fitBoundsOptions: { padding: VIEW_PADDING() },
        minZoom: 3,
        maxZoom: 15,
        maxBounds: [
          [86, -4],
          [130, 36],
        ],
        attributionControl: false,
      });
    } catch {
      setMapError(
        "Map rendering is unavailable in this browser. City forecasts are still available.",
      );
      return;
    }
    map.current = m;
    m.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: "OpenFreeMap / OpenMapTiles / OSM / Esri / Open-Meteo",
      }),
      "bottom-left",
    );
    // "style.load" is deterministic (every layer lives in the initial style);
    // "load" can be held up by a slow raster source, so it is only a backup.
    const markReady = () => setReady(true);
    m.on("style.load", markReady);
    m.on("load", markReady);
    const readyTimer = window.setTimeout(markReady, 2500);
    const resize = new ResizeObserver(() => m.resize());
    resize.observe(container.current);
    return () => {
      resize.disconnect();
      window.clearTimeout(readyTimer);
      cancelAnimationFrame(growRaf.current);
      m.remove();
      map.current = null;
      setReady(false);
    };
  }, []);

  /* ------------------------------------------- vector basemap availability */

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    let pixels = 0;
    const onData = (event: unknown) => {
      const e = event as { sourceId?: string };
      if (e?.sourceId !== VT) return;
      pixels += 1;
      // any vector traffic means the basemap is alive; individual tile errors
      // (cancelled pans, missing edge tiles) must never disable the layers
      setVectorDown(false);
    };
    m.on("sourcedata", onData);
    const timer = window.setTimeout(() => {
      let loaded = false;
      try {
        loaded = m.isSourceLoaded(VT) || pixels > 0;
      } catch {
        loaded = pixels > 0;
      }
      if (!loaded) setVectorDown(true);
    }, 14000);
    return () => {
      window.clearTimeout(timer);
      m.off("sourcedata", onData);
    };
  }, [ready]);

  /* ------------------------------------------------------------ mode theme */

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const theme = THEMES[mode];
    const set = (layer: string, prop: string, value: unknown) => {
      try {
        m.setPaintProperty(layer, prop as never, value as never);
      } catch {
        /* layer not ready yet */
      }
    };
    const fade = (layer: string, prop: string, value: unknown, dur: number) => {
      try {
        m.setPaintProperty(layer, (prop + "-transition") as never, {
          duration: reduce ? 0 : dur,
          delay: 0,
        } as never);
      } catch {
        /* ignore */
      }
      set(layer, prop, value);
    };
    const show = (layer: string, visible: boolean) => {
      try {
        m.setLayoutProperty(layer, "visibility", visible ? "visible" : "none");
      } catch {
        /* ignore */
      }
    };

    set("bg", "background-color", theme.bg);
    fade("satellite", "raster-opacity", theme.satOpacity, 420);
    fade("physical", "raster-opacity", theme.physicalOpacity, 420);
    set("satellite", "raster-saturation", theme.satSaturation);
    set("physical", "raster-saturation", theme.physSaturation);
    set("land", "fill-color", theme.bg === DARK.bg ? "#365860" : "#365860");
    fade("land", "fill-opacity", vectorDown ? 1 : 0, 300);
    fade("vt-water", "fill-opacity", theme.waterOpacity, 320);
    set("vt-water", "fill-color", theme.water);
    fade("vt-green", "fill-opacity", theme.greenOpacity, 320);
    set("vt-green", "fill-color", theme.green);
    fade("vt-park", "fill-opacity", theme.greenOpacity * 0.7, 320);
    fade("vt-built", "fill-opacity", theme.builtOpacity, 320);
    set("vt-built", "fill-color", theme.built);
    fade("vt-building", "fill-opacity", ["interpolate", ["linear"], ["zoom"], 13.2, 0, 14, theme.buildingOpacity * 2] as never, 260);
    set("vt-building", "fill-color", theme.building);
    set("vt-road-casing", "line-opacity", theme.roadMajorOpacity * 0.7);
    set("vt-road-major", "line-color", theme.roadMajor);
    set("vt-road-major", "line-opacity", theme.roadMajorOpacity);
    set("vt-road-mid", "line-color", theme.roadMid);
    set("vt-road-mid", "line-opacity", theme.roadMidOpacity);
    set("vt-road-minor", "line-color", theme.roadMinor);
    set("vt-road-minor", "line-opacity", ["interpolate", ["linear"], ["zoom"], 11.4, 0, 12.4, theme.roadMinorOpacity] as never);
    set("vt-b-country", "line-color", theme.countryLine);
    set("vt-b-country", "line-opacity", theme.countryOpacity);
    set("vt-b-province", "line-color", theme.provinceLine);
    set("vt-b-province", "line-opacity", ["interpolate", ["linear"], ["zoom"], 5, theme.provinceOpacity * 0.4, 8, theme.provinceOpacity] as never);
    set("vt-b-district", "line-color", theme.districtLine);
    set("vt-b-district", "line-opacity", ["interpolate", ["linear"], ["zoom"], 8, 0, 10, theme.districtOpacity] as never);
    set("land-borders", "line-color", mode === "dark" ? "#122e3c" : theme.countryLine);
    set("land-coast", "line-color", theme.countryLine);
    set("vt-place-country", "text-color", theme.countryText);
    set("vt-place-country", "text-halo-color", theme.placeHalo);
    set("vt-place-region", "text-color", theme.regionText);
    set("vt-place-region", "text-halo-color", theme.placeHalo);
    set("vt-water-name", "text-color", theme.waterText);
    set("vt-road-label", "text-color", theme.roadText);
    set("vt-road-label", "text-halo-color", theme.placeHalo);
    set("temp-rank-1", "text-halo-color", theme.placeHalo);
    set("temp-rank-2", "text-halo-color", theme.placeHalo);
    set("temp-rank-3", "text-halo-color", theme.placeHalo);
    set("temp-rank-4", "text-halo-color", theme.placeHalo);

    show("land", vectorDown);
    show("land-borders", vectorDown);
    show("land-coast", vectorDown);
    const vectorLayerIds = [
      "vt-water",
      "vt-green",
      "vt-park",
      "vt-built",
      "vt-building",
      "vt-road-casing",
      "vt-road-major",
      "vt-road-mid",
      "vt-road-minor",
      "vt-b-country",
      "vt-b-province",
      "vt-b-district",
      "vt-place-country",
      "vt-place-region",
      "vt-place-detail",
      "vt-water-name",
      "vt-road-label",
    ];
    for (const id of vectorLayerIds) show(id, !vectorDown);
    try {
      m.setLayoutProperty(
        "hillshade",
        "visibility",
        mode === "terrain" || threeD ? "visible" : "none",
      );
    } catch {
      /* ignore */
    }
  }, [mode, ready, reduce, threeD, vectorDown]);

  /* ----------------------------------------------------- field raster swap */

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    let timer = 0;
    timer = window.setTimeout(() => {
      timer = 0;
      const source = m.getSource("weather-field") as ImageSource | undefined;
      if (!source) return;
      try {
        const image = renderWeatherCanvas(
          weather,
          metric,
          hour,
          activeField ?? null,
        );
        if (image) {
          source.updateImage({
            image,
            coordinates: weatherImageCoordinates(activeField ?? null),
          });
        }
      } catch {
        /* image source still initialising */
      }
      try {
        m.setPaintProperty("weather-field", "raster-opacity-transition", {
          duration: reduce ? 0 : 380,
          delay: 0,
        } as never);
        m.setPaintProperty(
          "weather-field",
          "raster-opacity",
          fieldOpacity(mode, threeD, m.getZoom()) as never,
        );
      } catch {
        /* ignore */
      }
    }, 90);
    const onZoom = () => {
      try {
        m.setPaintProperty(
          "weather-field",
          "raster-opacity",
          fieldOpacity(mode, threeD, m.getZoom()) as never,
        );
      } catch {
        /* ignore */
      }
    };
    m.on("zoom", onZoom);
    return () => {
      window.clearTimeout(timer);
      m.off("zoom", onZoom);
    };
  }, [weather, metric, hour, fahrenheit, activeField, ready, mode, threeD, reduce]);

  /* ------------------------------------------------- gazetteer temp labels */

  // Rebuilding ~6.7k label features on every scrub tick would stall the main
  // thread, so the work is debounced and the payload is limited to the current
  // viewport and to the ranks that are actually visible at this zoom.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const source = m.getSource("places") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    if (!sampler.hasData) {
      try {
        source.setData({ type: "FeatureCollection", features: [] } as never);
      } catch {
        /* ignore */
      }
      return;
    }
    let timer = 0;

    const paint = () => {
      const zoom = m.getZoom();
      const maxRank = zoom < 4.2 ? 1 : zoom < 7 ? 2 : zoom < 9.5 ? 3 : 4;
      const view = m.getBounds();
      const marginLon = (view.getEast() - view.getWest()) * 0.12;
      const marginLat = (view.getNorth() - view.getSouth()) * 0.12;
      const west = view.getWest() - marginLon;
      const east = view.getEast() + marginLon;
      const south = view.getSouth() - marginLat;
      const north = view.getNorth() + marginLat;
      // Several communes share a name; keep the first one per ~3 km cell so the
      // map never stacks identical words on top of each other.
      const seen = new Set<string>();
      // Every monitored location already draws its own chip on the map, so the
      // gazetteer must not label the same spot again. This used to exempt only the
      // selected city, which left the two island groups showing a chip and a
      // gazetteer label stacked on top of each other.
      const chipped = weatherRef.current.map((w) => w.city);
      const nearChip = (place: Place) =>
        chipped.some(
          (city) =>
            Math.abs(place.lat - city.lat) < 0.05 &&
            Math.abs(place.lon - city.lon) < 0.055,
        );
      const visible = activePlaces.filter(
        (place) =>
          place.rank <= maxRank &&
          place.lon >= west &&
          place.lon <= east &&
          place.lat >= south &&
          place.lat <= north &&
          !nearChip(place) &&
          (() => {
            if (place.rank < 4) return true;
            const key =
              place.name +
              "@" +
              Math.round(place.lat / 0.012) +
              "," +
              Math.round(place.lon / 0.012);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })(),
      );
      try {
        source.setData(
          buildPlaceGeoJSON(visible, sampler, metric, fahrenheit) as never,
        );
      } catch {
        /* ignore */
      }
    };

    const schedule = (delay: number) => {
      if (timer) return; // already pending: never starve behind rapid re-renders
      timer = window.setTimeout(() => {
        timer = 0;
        paint();
      }, delay);
    };
    schedule(80);
    const onMoveEnd = () => schedule(220);
    m.on("moveend", onMoveEnd);
    return () => {
      window.clearTimeout(timer);
      m.off("moveend", onMoveEnd);
    };
  }, [activePlaces, sampler, metric, fahrenheit, ready, selectedCity]);

  /* ------------------------------------------------------------ city chips */

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const markers = weather.map((w) => {
      const value =
        hour === 0
          ? w.current[metric]
          : (w.hourly[hour]?.[metric] ?? w.current[metric]);
      const isSelected = w.city.id === selected;
      // The island groups are the easternmost points on the map and carry real
      // significance, so they keep their label at every zoom instead of collapsing
      // to a bare dot like the mainland cities do.
      const isIsland = w.city.region === "Islands";
      const el = document.createElement("button");
      el.className =
        "weather-city " +
        (isSelected ? "selected" : isIsland ? "island-chip" : "dot-only");
      el.setAttribute("aria-label", "View " + w.city.name);
      el.title = w.city.name;
      const dot = document.createElement("i");
      const name = document.createElement("span");
      const amount = document.createElement("b");
      name.textContent = w.city.name;
      amount.textContent =
        metric === "temperature"
          ? temperature(value, fahrenheit) + "\u00b0"
          : metric === "wind"
            ? String(Math.round(value))
            : value.toFixed(1);
      el.append(dot, name, amount);
      el.onclick = () => onSelectRef.current(w.city.id);
      const offsets: Record<string, [number, number]> = {
        hue: [-22, -10],
        "da-nang": [25, 10],
        "da-lat": [-23, 9],
        "nha-trang": [24, -5],
        hcmc: [25, -12],
        "can-tho": [-18, 7],
        hanoi: [-14, -7],
        "ha-long": [24, 5],
      };
      return new maplibregl.Marker({
        element: el,
        anchor: isSelected ? "bottom" : "center",
        offset: isSelected ? offsets[w.city.id] || [0, 0] : [0, 0],
      })
        .setLngLat([w.city.lon, w.city.lat])
        .addTo(m);
    });
    return () => markers.forEach((marker) => marker.remove());
  }, [weather, selected, metric, hour, fahrenheit, ready]);

  /* ------------------------------------------------------- label clicking */

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const ids = [
      "temp-rank-1",
      "temp-rank-2",
      "temp-rank-3",
      "temp-rank-4",
    ].filter((id) => Boolean(m.getLayer(id)));
    const nearestCity = (lon: number, lat: number) => {
      let best = "";
      let bestDistance = Infinity;
      for (const w of weatherRef.current) {
        const dy = lat - w.city.lat;
        const dx = (lon - w.city.lon) * Math.cos((lat * Math.PI) / 180);
        const d = dx * dx + dy * dy;
        if (d < bestDistance) {
          bestDistance = d;
          best = w.city.id;
        }
      }
      return best;
    };
    const onClick = (event: maplibregl.MapMouseEvent) => {
      const features = m.queryRenderedFeatures(event.point, { layers: ids });
      const geometry = features[0]?.geometry as
        | { type: string; coordinates?: [number, number] }
        | undefined;
      const coords = geometry?.coordinates;
      if (!coords) return;
      const id = nearestCity(coords[0], coords[1]);
      if (id) onSelectRef.current(id);
    };
    const enter = () => {
      m.getCanvas().style.cursor = "pointer";
    };
    const leave = () => {
      m.getCanvas().style.cursor = "";
    };
    for (const id of ids) {
      m.on("mouseenter", id, enter);
      m.on("mouseleave", id, leave);
    }
    m.on("click", onClick);
    return () => {
      for (const id of ids) {
        m.off("mouseenter", id, enter);
        m.off("mouseleave", id, leave);
      }
      m.off("click", onClick);
    };
  }, [ready, activePlaces]);

  /* -------------------------------------------------- selection follow-map */

  useEffect(() => {
    const m = map.current;
    if (!m || !ready || selected === lastSelected.current) return;
    const city = weather.find((w) => w.city.id === selected)?.city;
    if (city) {
      m.easeTo({
        center: [city.lon, city.lat],
        offset: window.innerWidth > 700 ? [50, 0] : [65, 30],
        duration: reduce ? 0 : 850,
      });
      lastSelected.current = selected;
    }
  }, [selected, weather, ready, reduce]);

  /* ---------------------------------------------------------- 3D terrain */

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    try {
      if (threeD) {
        m.setTerrain({ source: "terrain-dem", exaggeration: 1.6 });
      } else {
        m.setTerrain(null);
      }
    } catch {
      /* terrain unavailable */
    }
    if (threeD && zoomBefore3D.current === null) zoomBefore3D.current = m.getZoom();
    const targetZoom = threeD
      ? Math.max(m.getZoom(), 5.35)
      : (zoomBefore3D.current ?? m.getZoom());
    if (!threeD) zoomBefore3D.current = null;
    m.easeTo({
      pitch: threeD ? 58 : 0,
      bearing: threeD ? -18 : 0,
      zoom: targetZoom,
      duration: reduce ? 0 : 900,
      essential: true,
    });
    try {
      const vis = threeD ? "visible" : "none";
      m.setLayoutProperty("weather-columns", "visibility", vis);
      m.setLayoutProperty("column-glow", "visibility", vis);
      if (!threeD) {
        cancelAnimationFrame(growRaf.current);
        (m.getSource("weather-columns") as maplibregl.GeoJSONSource).setData({
          type: "FeatureCollection",
          features: [],
        } as never);
        (m.getSource("column-points") as maplibregl.GeoJSONSource).setData({
          type: "FeatureCollection",
          features: [],
        } as never);
        heightsRef.current = new Map();
      }
    } catch {
      /* ignore */
    }
  }, [threeD, ready, reduce]);

  /* ------------------------------------------------------- 3D columns data */

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    columnsRef.current = weather.map((w) => ({
      id: w.city.id,
      lon: w.city.lon,
      lat: w.city.lat,
      rings: buildRings(w.city.lon, w.city.lat),
    }));
    if (!threeD) return;
    cancelAnimationFrame(growRaf.current);

    const targets = new Map<string, { h: number; color: string }>();
    for (const w of weather) {
      const value =
        hour === 0
          ? w.current[metric]
          : (w.hourly[hour]?.[metric] ?? w.current[metric]);
      targets.set(w.city.id, {
        h: columnHeight(value, metric),
        color: columnColor(value, metric),
      });
    }
    const from = new Map<string, number>();
    for (const c of columnsRef.current)
      from.set(c.id, heightsRef.current.get(c.id) ?? 0);

    const draw = (progress: number) => {
      const features: unknown[] = [];
      const points: unknown[] = [];
      for (const c of columnsRef.current) {
        const target = targets.get(c.id);
        if (!target) continue;
        const start = from.get(c.id) ?? 0;
        const h = start + (target.h - start) * progress;
        heightsRef.current.set(c.id, h);
        for (let i = 0; i < c.rings.length; i++) {
          const t0 = i / c.rings.length;
          const t1 = (i + 1) / c.rings.length;
          features.push({
            type: "Feature",
            properties: {
              color: target.color,
              base: Math.round(h * t0),
              height: Math.round(h * t1),
            },
            geometry: { type: "Polygon", coordinates: [c.rings[i]] },
          });
        }
        points.push({
          type: "Feature",
          properties: { color: target.color },
          geometry: { type: "Point", coordinates: [c.lon, c.lat] },
        });
      }
      try {
        (m.getSource("weather-columns") as maplibregl.GeoJSONSource).setData({
          type: "FeatureCollection",
          features,
        } as never);
        (m.getSource("column-points") as maplibregl.GeoJSONSource).setData({
          type: "FeatureCollection",
          features: points,
        } as never);
      } catch {
        /* ignore */
      }
    };

    if (reduce) {
      draw(1);
      return;
    }
    const duration = 820;
    const startedAt = performance.now();
    const frame = (now: number) => {
      const p = Math.min(1, (now - startedAt) / duration);
      const e = Math.pow(1 - p, 3);
      draw(1 - e);
      if (p < 1) growRaf.current = requestAnimationFrame(frame);
    };
    growRaf.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(growRaf.current);
  }, [weather, metric, hour, threeD, ready, reduce]);

  /* ------------------------------------------------------ wind particles */

  useEffect(() => {
    const m = map.current;
    const c = canvas.current;
    if (!m || !c || !ready) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    if (!particles || metric !== "wind" || !weather.length || reduce) {
      ctx.clearRect(0, 0, c.width, c.height);
      return;
    }
    let frame = 0;
    let lastTime = 0;
    const dots = Array.from(
      { length: window.innerWidth < 700 ? 160 : threeD ? 260 : 420 },
      () => ({
        x: Math.random() * c.clientWidth,
        y: Math.random() * c.clientHeight,
        age: Math.random() * 80,
      }),
    );
    function draw(time: number) {
      if (!c || !ctx || !m) return;
      frame = requestAnimationFrame(draw);
      if (time - lastTime < 32) return;
      const frameStep = Math.min(2, (time - lastTime) / 33);
      lastTime = time;
      if (c.width !== c.clientWidth || c.height !== c.clientHeight) {
        c.width = c.clientWidth;
        c.height = c.clientHeight;
      }
      // Fade the previous frame harder so each particle leaves a short comet
      // tail instead of a long rope that reads as rain.
      ctx.globalCompositeOperation = "destination-in";
      ctx.fillStyle = "rgba(0,0,0,.82)";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.globalCompositeOperation = "source-over";
      const zoom = m.getZoom();
      ctx.strokeStyle = threeD
        ? "rgba(224,246,255,.30)"
        : zoom > 9
          ? "rgba(221,243,251,.38)"
          : "rgba(228,248,255,.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      const current = samplerRef.current;
      for (const dot of dots) {
        if (
          dot.age++ > 90 ||
          dot.x < 0 ||
          dot.x > c.width ||
          dot.y < 0 ||
          dot.y > c.height
        ) {
          dot.x = Math.random() * c.width;
          dot.y = Math.random() * c.height;
          dot.age = 0;
        }
        const location = m.unproject([dot.x, dot.y]);
        const wind = current.wind(location.lng, location.lat);
        if (!wind) {
          dot.age = 100;
          continue;
        }
        // Direction comes from a small geographic probe projected into pixel
        // space; the particle then advances a fixed number of PIXELS per frame.
        // The previous version scaled the pixel delta by the same geographic
        // epsilon used for the probe, which squared the factor and left every
        // streak moving well under a thousandth of a pixel - visibly dead.
        const origin = m.project([location.lng, location.lat]);
        const probe = m.project([
          location.lng + wind.u * 0.05,
          location.lat + wind.v * 0.05,
        ]);
        const dirX = probe.x - origin.x;
        const dirY = probe.y - origin.y;
        const dirLen = Math.hypot(dirX, dirY);
        if (!(dirLen > 1e-6) || !Number.isFinite(dirLen)) {
          dot.age = 100;
          continue;
        }
        const windSpeed = Math.hypot(wind.u, wind.v);
        const advance = Math.min(2.4, 0.55 + windSpeed * 0.05) * frameStep;
        const dx = (dirX / dirLen) * advance;
        const dy = (dirY / dirLen) * advance;
        ctx.moveTo(dot.x, dot.y);
        dot.x += dx;
        dot.y += dy;
        ctx.lineTo(dot.x, dot.y);
      }
      ctx.stroke();
    }
    const clear = () => ctx.clearRect(0, 0, c.width, c.height);
    m.on("move", clear);
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      m.off("move", clear);
      clear();
    };
  }, [ready, weather, metric, particles, hour, reduce, threeD]);

  function reset() {
    map.current?.fitBounds(FIT_BOUNDS, {
      padding: VIEW_PADDING(),
      pitch: 0,
      bearing: 0,
      duration: reduce ? 0 : 700,
    });
  }

  const modes: { id: MapMode; label: string; icon: typeof Moon }[] = [
    { id: "dark", label: "Dark", icon: Moon },
    { id: "satellite", label: "Satellite", icon: Satellite },
    { id: "terrain", label: "Terrain", icon: Mountain },
  ];
  const modeIndex = Math.max(0, modes.findIndex((mm) => mm.id === mode));
  const gridded = Boolean(activeField && activeField.model !== "city-blend");
  const stale = Boolean(activeField?.stale);

  return (
    <div className="weather-map">
      <div
        ref={container}
        className="full-map-canvas"
        aria-label="Interactive Vietnam weather map"
      />
      <canvas className="wind-particles" ref={canvas} aria-hidden="true" />
      <div className="map-vignette" />

      <div className="map-mode-dock" role="group" aria-label="Basemap style">
        <div className="map-mode-group">
          <span
            className="mode-indicator"
            style={{ transform: "translateY(" + modeIndex * 42 + "px)" }}
          />
          {modes.map((item) => (
            <button
              key={item.id}
              className={"map-mode-btn " + (mode === item.id ? "selected" : "")}
              aria-pressed={mode === item.id}
              aria-label={item.label + " basemap"}
              title={item.label + " basemap"}
              onClick={() => chooseMode(item.id)}
            >              <item.icon size={18} />
            </button>
          ))}
        </div>
        <span className="mode-dock-sep" />
        <button
          className={"map-mode-btn mode-3d " + (threeD ? "selected" : "")}
          aria-pressed={threeD}
          aria-label="Toggle 3D terrain view"
          title="3D terrain"
          onClick={() => toggleThreeD(!threeD)}
        >
          <Box size={18} />
          <small>3D</small>
        </button>
      </div>

      <div className="weather-map-controls">
        <button aria-label="Reset map to Vietnam" onClick={reset}>
          <Compass size={19} />
        </button>
        <span />
        <button aria-label="Zoom in" onClick={() => map.current?.zoomIn()}>
          <Plus size={20} />
        </button>
        <button aria-label="Zoom out" onClick={() => map.current?.zoomOut()}>
          <Minus size={20} />
        </button>
        <span />
        <button aria-label="Fit Vietnam" onClick={reset}>
          <Maximize2 size={17} />
        </button>
      </div>

      <div className="weather-scale">
        <div>
          <b>
            {metric === "temperature"
              ? "Temperature"
              : metric === "precipitation"
                ? "Rainfall"
                : "Wind speed"}
          </b>
          <span>
            {metric === "temperature"
              ? fahrenheit
                ? "\u00b0F"
                : "\u00b0C"
              : metric === "wind"
                ? "km/h"
                : "mm"}
          </span>
        </div>
        <div className={"scale-gradient " + metric} />
        <div className="scale-labels">
          {scales[metric].map(([value]) => (
            <span key={value}>
              {metric === "temperature" ? temperature(value, fahrenheit) : value}
            </span>
          ))}
        </div>
        {metric === "wind" && hour > 0 && (
          <small>Direction from current observations</small>
        )}
        {threeD && (
          <small className="scale-3d">
            {"3D columns - " + (metric === "precipitation" ? "rainfall" : metric)}
          </small>
        )}
        {modelLabel && (
          <div className="map-model-chip">
            <b>{modelLabel}</b>
            <span>{gridded ? "dense grid" : "city blend"}</span>
            {stale && <em>cached</em>}
          </div>
        )}
      </div>

      {mapError && (
        <div className="weather-map-error" role="alert">
          {mapError}
        </div>
      )}
    </div>
  );
}