import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Cloud,
  CloudLightning,
  CloudMoon,
  CloudRain,
  Command as CommandIcon,
  Database,
  Droplets,
  Gauge,
  Layers,
  LocateFixed,
  Maximize2,
  Menu,
  Moon,
  Pause,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  Sun,
  Thermometer,
  Wind,
  X,
} from "lucide-react";
import WeatherMap from "./WeatherMap";
import { Ambient } from "./Ambient";
import {
  AirQualityCard,
  AlertStack,
  CommandPalette,
  DetailGrid,
  HourlyChart,
  MoonCard,
  SunArc,
} from "./Panels";
import { AnalyticsPanel, PipelinePanel } from "./DataPanels";
import { AnimatedNumber, InteractionLayer, Reveal, Stagger } from "./motion";
import {
  type Weather,
  type Metric,
  type Analytics,
  type MapMode,
  type Field,
  type Place,
  WEATHER_MODELS,
  aqiBand,
  condition,
  dayLabel,
  hourLabel,
  normalize,
  temperature,
} from "./types";

/* --------------------------------------------------------------- helpers */

function WeatherIcon({ code, size = 24 }: { code: number; size?: number }) {
  const Icon =
    code >= 95 ? CloudLightning : code >= 51 ? CloudRain : code === 0 ? Sun : Cloud;
  return <Icon size={size} />;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error("Request failed (" + response.status + ")");
  return response.json();
}

type Drawer = "Analytics" | "Data pipeline" | "7-day forecast" | "Atmosphere" | null;

const DOCK_TABS = [
  { id: "overview", label: "Overview", icon: Layers },
  { id: "hourly", label: "Hourly", icon: Activity },
  { id: "sky", label: "Sky", icon: Moon },
  { id: "air", label: "Air", icon: Sparkles },
] as const;

const LAYERS = [
  { id: "wind", label: "Wind", detail: "Surface wind", icon: Wind },
  { id: "temperature", label: "Temperature", detail: "Degrees", icon: Thermometer },
  { id: "precipitation", label: "Rainfall", detail: "Precipitation", icon: CloudRain },
] as const;

const BASEMAPS = [
  { id: "dark", label: "Dark", icon: Layers },
  { id: "satellite", label: "Satellite", icon: Maximize2 },
  { id: "terrain", label: "Terrain", icon: Gauge },
] as const;

/* ------------------------------------------------------------------- app */

export default function App() {
  const [weather, setWeather] = useState<Weather[]>([]);
  const [selected, setSelected] = useState("hanoi");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [region, setRegion] = useState("All regions");
  const [metric, setMetric] = useState<Metric>("temperature");
  const [hour, setHour] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fahrenheit, setFahrenheit] = useState(
    () => localStorage.getItem("vw-unit") === "F",
  );
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("vw-favorites") || '["hanoi","da-nang","hcmc"]',
      );
      return Array.isArray(saved) ? saved : [];
    } catch {
      return ["hanoi"];
    }
  });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [providerError, setProviderError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [particles, setParticles] = useState(true);
  const [mapMode, setMapMode] = useState<MapMode>("dark");
  const [field, setField] = useState<Field | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [model, setModel] = useState(
    () => localStorage.getItem("vw-model") || "ecmwf_ifs025",
  );
  const [threeD, setThreeD] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tab, setTab] = useState<(typeof DOCK_TABS)[number]["id"]>("overview");
  const [dismissed, setDismissed] = useState<string[]>([]);

  const searchBox = useRef<HTMLDivElement>(null);
  const menuBox = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const refreshingRef = useRef(false);
  const hoursRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const [data, nextField] = await Promise.all([
        get<{ cities: Weather[]; providerError: string | null }>("/api/weather"),
        get<Field>("/api/field?model=" + encodeURIComponent(model)).catch(
          () => null,
        ),
      ]);
      setWeather(data.cities);
      setProviderError(data.providerError);
      // "synthetic" means the backend had to invent colours because the provider is
      // unavailable; the map's own city-derived field is built from real cached
      // observations, so prefer that instead of drawing fiction.
      if (nextField && Array.isArray(nextField.points) && nextField.source !== "synthetic") {
        setField(nextField);
      } else if (nextField) {
        setField(null);
      }
      setError("");
    } catch {
      setError("Weather service unavailable. Please try again.");
    } finally {
      setRefreshing(false);
      refreshingRef.current = false;
    }
  }, [model]);

  useEffect(() => {
    void get<Place[]>("/api/places")
      .then((rows) => {
        if (Array.isArray(rows) && rows.length) setPlaces(rows);
      })
      .catch(() => setPlaces([]));
  }, []);

  useEffect(() => {
    localStorage.setItem("vw-model", model);
  }, [model]);

  useEffect(() => {
    void refresh();
    const stream = new EventSource("/api/events");
    stream.addEventListener("weather", () => {
      setConnected(true);
      void refresh();
    });
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    const interval = setInterval(() => void refresh(), 60000);
    return () => {
      stream.close();
      clearInterval(interval);
    };
  }, [refresh]);

  const current = weather.find((w) => w.city.id === selected) || weather[0];
  const maxHour = weather.length
    ? Math.max(0, Math.min(23, ...weather.map((w) => w.hourly.length - 1)))
    : 0;

  useEffect(() => {
    setHour((h) => Math.min(h, maxHour));
  }, [maxHour]);

  useEffect(() => {
    if (!playing || !maxHour) return;
    const interval = setInterval(() => setHour((h) => (h + 1) % (maxHour + 1)), 1300);
    return () => clearInterval(interval);
  }, [playing, maxHour]);

  useEffect(() => {
    localStorage.setItem("vw-unit", fahrenheit ? "F" : "C");
  }, [fahrenheit]);
  useEffect(() => {
    localStorage.setItem("vw-favorites", JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => {
    const container = hoursRef.current;
    const active = container?.children[hour] as HTMLElement | undefined;
    if (container && active) {
      const left = active.offsetLeft - (container.children[0] as HTMLElement).offsetLeft;
      if (
        left < container.scrollLeft ||
        left + active.offsetWidth > container.scrollLeft + container.clientWidth
      )
        container.scrollLeft = Math.max(0, left - container.clientWidth / 2);
    }
  }, [hour, expanded]);

  useEffect(() => {
    if (!drawer) return;
    let active = true;
    const load = () =>
      get<Analytics>("/api/analytics")
        .then((a) => {
          if (active) setAnalytics(a);
        })
        .catch(() => {
          if (active) setAnalytics(null);
        });
    void load();
    const interval = setInterval(load, 10000);
    const previous = document.activeElement as HTMLElement | null;
    drawerRef.current?.focus();
    return () => {
      active = false;
      clearInterval(interval);
      previous?.focus();
    };
  }, [drawer]);

  useEffect(() => {
    function close(event: PointerEvent) {
      if (!searchBox.current?.contains(event.target as Node)) setSearchOpen(false);
      if (!menuBox.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function keyboard(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setMenuOpen(false);
        setPaletteOpen(false);
        setDrawer(null);
      }
      if (event.key === "Tab" && drawerRef.current) {
        const elements = drawerRef.current.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, [tabindex="0"]',
        );
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === drawerRef.current)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", keyboard);
    };
  }, []);

  const filtered = weather.filter(
    (w) =>
      (region === "All regions" || w.city.region === region) &&
      normalize(w.city.name).includes(normalize(search)),
  );

  const t = (value: number) => temperature(value, fahrenheit);
  const sample = weather.length > 0 && weather.every((w) => w.source === "demo");
  const point =
    current && (hour === 0 ? current.current : current.hourly[hour] || current.current);
  const pointTime =
    current &&
    (hour === 0 ? current.observedAt : current.hourly[hour]?.time || current.observedAt);

  const alerts = useMemo(
    () => (current?.alerts || []).filter((a) => !dismissed.includes(a.id)),
    [current, dismissed],
  );
  const band = current?.airQuality ? aqiBand(current.airQuality.aqi) : null;

  function selectCity(id: string) {
    setSelected(id);
    setSearchOpen(false);
    setSearch("");
    setPaletteOpen(false);
  }

  function locate() {
    if (!navigator.geolocation) {
      setNotice("Location is unavailable. Search for a city instead.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const distance = (w: Weather) =>
          Math.hypot(
            w.city.lat - position.coords.latitude,
            (w.city.lon - position.coords.longitude) *
              Math.cos((position.coords.latitude * Math.PI) / 180),
          );
        const nearest = [...weather].sort((a, b) => distance(a) - distance(b))[0];
        if (nearest) {
          selectCity(nearest.city.id);
          setNotice("Nearest monitored city: " + nearest.city.name + ".");
        }
      },
      () => setNotice("Location access is unavailable. Search for a city instead."),
      { timeout: 10000 },
    );
  }

  function favorite(id: string) {
    setFavorites((values) =>
      values.includes(id) ? values.filter((v) => v !== id) : [...values, id],
    );
  }

  function openDrawer(value: Exclude<Drawer, null>) {
    menuButton.current?.focus();
    setDrawer(value);
    setMenuOpen(false);
  }

  const appClass = [
    "weather-app",
    expanded ? "forecast-expanded" : "forecast-collapsed",
    "mode-" + mapMode,
    threeD ? "is-3d" : "",
  ].join(" ");

  return (
    <InteractionLayer>
      <div className={appClass}>
        <WeatherMap
          weather={weather}
          selected={selected}
          onSelect={selectCity}
          metric={metric}
          hour={hour}
          fahrenheit={fahrenheit}
          particles={particles}
          field={field}
          places={places}
          model={model}
          mode={mapMode}
          threeD={threeD}
          onModeChange={(m) => setMapMode(m)}
          onThreeDChange={(v) => setThreeD(v)}
        />

        <Ambient
          code={current?.current.code ?? 1}
          isDay={current ? current.current.isDay : true}
          wind={current?.current.wind ?? 10}
          intensity={0.9}
        />

        <header className="floating-header">
          <a className="weather-brand" href="/" aria-label="VieWeather home">
            <span className="weather-brand-icon">
              <Wind size={25} />
            </span>
            <span>
              vie<span className="brand-light">weather</span>
              <small>VIETNAM, IN EVERY ELEMENT.</small>
            </span>
          </a>
          <div className="header-right">
            <button
              className="search-launcher"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
            >
              <Search size={15} />
              <span>Search cities</span>
              <kbd>
                <CommandIcon size={10} />K
              </kbd>
            </button>
            <span className={"connection-pill" + (sample ? " is-demo" : "")}>
              <i className={connected ? "" : "disconnected"} />
              {!current
                ? "Connecting"
                : sample
                  ? "Sample weather"
                  : current.stale
                    ? "Cached weather"
                    : "Live weather"}
            </span>
            <div className="menu-anchor" ref={menuBox}>
              <button
                ref={menuButton}
                className={"round-button menu-button" + (menuOpen ? " is-active" : "")}
                aria-label="Open menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(!menuOpen)}
              >
                {menuOpen ? <X size={20} /> : <Menu size={20} />}
              </button>
              {menuOpen && (
                <div className="app-menu">
                  <span className="mini-label">YOUR WORKSPACE</span>
                  <button onClick={() => openDrawer("7-day forecast")}>
                    <Sun size={17} />
                    7-day forecast
                    <ChevronRight size={15} />
                  </button>
                  <button onClick={() => openDrawer("Atmosphere")}>
                    <Sparkles size={17} />
                    Atmosphere
                    <ChevronRight size={15} />
                  </button>
                  <button onClick={() => openDrawer("Analytics")}>
                    <BarChart3 size={17} />
                    Weather analytics
                    <ChevronRight size={15} />
                  </button>
                  <button onClick={() => openDrawer("Data pipeline")}>
                    <Database size={17} />
                    Data pipeline
                    <ChevronRight size={15} />
                  </button>
                  <a href="/api/export">
                    <ArrowDown size={17} />
                    Export observations
                  </a>
                  <div className="menu-units">
                    <span>Temperature units</span>
                    <button aria-pressed={!fahrenheit} onClick={() => setFahrenheit(false)}>
                      °C
                    </button>
                    <button aria-pressed={fahrenheit} onClick={() => setFahrenheit(true)}>
                      °F
                    </button>
                  </div>
                  <div className="menu-models">
                    <span className="mini-label">FORECAST MODEL</span>
                    {WEATHER_MODELS.map((m) => (
                      <button
                        key={m.id}
                        aria-pressed={model === m.id}
                        title={m.detail}
                        onClick={() => setModel(m.id)}
                      >
                        <b>{m.label}</b>
                        <small>{m.detail}</small>
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => {
                      void refresh();
                      setMenuOpen(false);
                    }}
                  >
                    <RefreshCw size={17} />
                    Refresh weather
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <aside className="location-panel" aria-label="Location forecast">
          <div className="search-anchor" ref={searchBox}>
            <div className="weather-search">
              <Search size={19} />
              <input
                aria-label="Search cities"
                placeholder="Search a location…"
                value={search}
                onFocus={() => setSearchOpen(true)}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setSearchOpen(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && filtered[0]) selectCity(filtered[0].city.id);
                }}
              />
              <button
                aria-label="Find my nearest city"
                onClick={locate}
                disabled={!weather.length}
              >
                <LocateFixed size={19} />
              </button>
            </div>
            {searchOpen && (
              <div className="search-results">
                <div className="search-filter">
                  <span>{filtered.length} locations</span>
                  <select
                    aria-label="Filter by region"
                    value={region}
                    onChange={(event) => setRegion(event.target.value)}
                  >
                    {["All regions", ...new Set(weather.map((w) => w.city.region))].map(
                      (r) => (
                        <option key={r}>{r}</option>
                      ),
                    )}
                  </select>
                </div>
                {filtered.length ? (
                  filtered.map((w) => (
                    <button
                      key={w.city.id}
                      className="search-result"
                      onClick={() => selectCity(w.city.id)}
                    >
                      <span>
                        {w.city.name}
                        <small>{w.city.region} Vietnam</small>
                      </span>
                      <WeatherIcon code={w.current.code} size={18} />
                      <b>{t(w.current.temperature)}°</b>
                    </button>
                  ))
                ) : (
                  <p className="search-empty">
                    {weather.length
                      ? "No matching cities. Try another name."
                      : "Waiting for weather data…"}
                  </p>
                )}
              </div>
            )}
          </div>

          {current && point ? (
            <Reveal className="location-card-reveal" y={18}>
              <section className="location-card">
                <div className="location-heading">
                  <div>
                    <span className="mini-label">
                      {current.city.region.toUpperCase()} VIETNAM
                    </span>
                    <h1>{current.city.name}</h1>
                  </div>
                  <button
                    className={
                      "save-button" +
                      (favorites.includes(current.city.id) ? " saved" : "")
                    }
                    aria-label={
                      favorites.includes(current.city.id) ? "Remove saved city" : "Save city"
                    }
                    aria-pressed={favorites.includes(current.city.id)}
                    onClick={() => favorite(current.city.id)}
                  >
                    <Star
                      size={19}
                      fill={favorites.includes(current.city.id) ? "currentColor" : "none"}
                    />
                  </button>
                </div>
                <div className="location-time">
                  {hour === 0 ? "Current conditions" : "Forecast"}
                  <span>·</span>
                  {hourLabel(pointTime!)} ICT
                  {current.stale && <span>· cached</span>}
                </div>
                <div className="current-summary">
                  <div className="current-degree">
                    <AnimatedNumber value={t(point.temperature)} />
                    <span>°</span>
                  </div>
                  <div className="current-condition">
                    {current.current.isDay ? (
                      <WeatherIcon code={point.code} size={38} />
                    ) : (
                      <CloudMoon size={38} />
                    )}
                    <span>{condition(point.code)}</span>
                  </div>
                </div>
                <div className="temperature-range">
                  {hour === 0
                    ? "Feels like " + t(current.current.feelsLike) + "°"
                    : "Hourly forecast"}
                  {current.daily[0] && (
                    <span>
                      <ArrowUp size={12} />
                      {t(current.daily[0].high)}° <ArrowDown size={12} />
                      {t(current.daily[0].low)}°
                    </span>
                  )}
                </div>

                {band && current.airQuality && (
                  <button
                    className="aqi-chip"
                    style={{ "--aqi-color": band.color } as React.CSSProperties}
                    onClick={() => setTab("air")}
                    title="Open air quality"
                  >
                    <i />
                    <b>AQI {current.airQuality.aqi}</b>
                    <small>{band.label}</small>
                  </button>
                )}

                <div className="compact-stats">
                  <div>
                    <Wind size={17} />
                    <strong>
                      <AnimatedNumber value={Math.round(point.wind)} />
                      <small> km/h</small>
                    </strong>
                    <span>Wind</span>
                  </div>
                  <div>
                    <Droplets size={17} />
                    <strong>
                      <AnimatedNumber value={point.humidity} />
                      <small>%</small>
                    </strong>
                    <span>Humidity</span>
                  </div>
                  <div>
                    <CloudRain size={17} />
                    <strong>
                      <AnimatedNumber value={point.precipitation} decimals={1} />
                      <small> mm</small>
                    </strong>
                    <span>Rain</span>
                  </div>
                </div>

              </section>
            </Reveal>
          ) : (
            <section className="location-card weather-loading">
              <RefreshCw className={refreshing ? "spin" : ""} />
              <h2>{error ? "Connection unavailable" : "Loading your forecast"}</h2>
              <p>{error || "A little perspective on the weather ahead."}</p>
              {error && <button onClick={() => void refresh()}>Try again</button>}
            </section>
          )}

          <div className="saved-places">
            <span className="mini-label">QUICK LOCATIONS</span>
            <div>
              {favorites.map((id) => {
                const w = weather.find((city) => city.city.id === id);
                return (
                  w && (
                    <button
                      key={id}
                      className={selected === id ? "selected" : ""}
                      onClick={() => selectCity(id)}
                    >
                      {w.city.name}
                      <span>{t(w.current.temperature)}°</span>
                    </button>
                  )
                );
              })}
              {!favorites.length && (
                <span className="saved-hint">Star a city to save it here.</span>
              )}
            </div>
          </div>

        </aside>

        {(notice || error || providerError) && (
          <div className="weather-notice" role="status">
            <span>
              {error ||
                notice ||
                "Live provider unavailable. Showing the latest available data."}
            </span>
            <button
              aria-label={
                error || providerError ? "Retry weather connection" : "Dismiss notice"
              }
              onClick={() => {
                setNotice("");
                if (error || providerError) void refresh();
              }}
            >
              {error || providerError ? <RefreshCw size={15} /> : <X size={15} />}
            </button>
          </div>
        )}

        <div className="map-bottom-info">
          <span className="map-source">
            <i />
            {sample
              ? "DEMO"
              : current?.stale
                ? "CACHED"
                : current
                  ? "OPEN-METEO"
                  : "CONNECTING"}
            <span>
              {(WEATHER_MODELS.find((m) => m.id === model) || WEATHER_MODELS[1]).label}
              {field ? " · " + field.cols + "×" + field.rows + " grid" : " · city grid"}
            </span>
            <span className="map-credit">
              Imagery © Esri · OpenStreetMap · Natural Earth
            </span>
          </span>
        </div>

        <footer className="forecast-dock">
          <section className="insight-dock" aria-label="Weather insights">
            <header>
              <div className="dock-tabs" role="tablist">
                {DOCK_TABS.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    role="tab"
                    aria-selected={tab === id}
                    className={tab === id ? "selected" : ""}
                    onClick={() => setTab(id)}
                  >
                    <Icon size={14} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
              <div className="dock-tools">
                <div className="dock-layers" role="group" aria-label="Weather layer">
                  {LAYERS.map((layer) => (
                    <button
                      key={layer.id}
                      aria-label={layer.label}
                      title={layer.detail}
                      className={"layer-chip" + (metric === layer.id ? " selected" : "")}
                      aria-pressed={metric === layer.id}
                      onClick={() => setMetric(layer.id)}
                    >
                      <layer.icon size={13} />
                      <span>{layer.label}</span>
                    </button>
                  ))}
                </div>
                <span className="dock-sep" />
                <label
                  className={"particle-setting" + (metric !== "wind" ? " unavailable" : "")}
                >
                  <input
                    type="checkbox"
                    checked={particles}
                    disabled={metric !== "wind"}
                    onChange={(event) => setParticles(event.target.checked)}
                  />
                  <span />
                  Wind animation
                </label>
                <span className="dock-sep" />
                <button
                  className="dock-collapse"
                  aria-label={expanded ? "Collapse forecast" : "Expand forecast"}
                  aria-expanded={expanded}
                  onClick={() => setExpanded((v) => !v)}
                >
                  <ChevronDown size={15} className={!expanded ? "turned" : ""} />
                </button>
              </div>
            </header>
            <div className="dock-body">
              {!current ? (
                <p className="dock-placeholder">Waiting for observations…</p>
              ) : tab === "overview" ? (
                <Stagger className="dock-grid overview-grid" gap={70}>
                  <div className="dock-cell">
                    <DetailGrid current={current.current} fahrenheit={fahrenheit} />
                  </div>
                  <div className="dock-cell">
                    {current.airQuality ? (
                      <AirQualityCard aq={current.airQuality} compact />
                    ) : (
                      <p className="dock-placeholder">Air quality unavailable.</p>
                    )}
                  </div>
                  <div className="dock-cell">
                    {alerts.length ? (
                      <AlertStack
                        alerts={alerts}
                        onDismiss={(id) => setDismissed((d) => [...d, id])}
                      />
                    ) : current.sun ? (
                      <SunArc sun={current.sun} isDay={current.current.isDay} />
                    ) : null}
                  </div>
                </Stagger>
              ) : tab === "hourly" ? (
                <HourlyChart
                  hourly={current.hourly}
                  hour={hour}
                  fahrenheit={fahrenheit}
                  metric={metric}
                  onScrub={(h) => {
                    setPlaying(false);
                    setHour(h);
                  }}
                />
              ) : tab === "sky" ? (
                <Stagger className="dock-grid sky-grid" gap={70}>
                  <div className="dock-cell">
                    {current.sun ? (
                      <SunArc sun={current.sun} isDay={current.current.isDay} />
                    ) : null}
                  </div>
                  <div className="dock-cell">
                    {current.moon ? <MoonCard moon={current.moon} /> : null}
                  </div>
                  <div className="dock-cell">
                    <span className="mini-label">NEXT 7 DAYS</span>
                    <div className="seven-day">
                      {current.daily.slice(0, 7).map((d) => (
                        <div key={d.date}>
                          <span>{dayLabel(d.date)}</span>
                          <WeatherIcon code={d.code} size={14} />
                          <b>{t(d.high)}°</b>
                          <small>{t(d.low)}°</small>
                        </div>
                      ))}
                    </div>
                  </div>
                </Stagger>
              ) : (
                <Stagger className="dock-grid air-grid" gap={70}>
                  <div className="dock-cell">
                    {current.airQuality ? (
                      <AirQualityCard aq={current.airQuality} />
                    ) : (
                      <p className="dock-placeholder">Air quality unavailable.</p>
                    )}
                  </div>
                  <div className="dock-cell">
                    {alerts.length ? (
                      <AlertStack
                        alerts={alerts}
                        onDismiss={(id) => setDismissed((d) => [...d, id])}
                      />
                    ) : (
                      <div className="alerts-empty">
                        <Sparkles size={20} />
                        <b>No active alerts</b>
                        <span>
                          Conditions are within normal ranges for {current.city.name}.
                        </span>
                      </div>
                    )}
                  </div>
                </Stagger>
              )}
            </div>
          </section>
          <div className="time-controls">
            <button
              className="play-forecast"
              aria-label={playing ? "Pause forecast" : "Play forecast"}
              disabled={!maxHour}
              onClick={() => setPlaying(!playing)}
            >
              {playing ? (
                <Pause size={19} fill="currentColor" />
              ) : (
                <Play size={19} fill="currentColor" />
              )}
            </button>
            <div className="time-current">
              <b>{hour === 0 ? "Now" : pointTime ? hourLabel(pointTime) : "—"}</b>
              <span>
                {pointTime ? dayLabel(pointTime) : "Loading"}
                <small> UTC+7</small>
              </span>
            </div>
            <div className="forecast-scrubber">
              <input
                aria-label="Forecast hour"
                type="range"
                min="0"
                max={maxHour}
                value={hour}
                disabled={!maxHour}
                style={
                  {
                    "--progress": (maxHour ? (hour / maxHour) * 100 : 0) + "%",
                  } as React.CSSProperties
                }
                onChange={(event) => {
                  setPlaying(false);
                  setHour(Number(event.target.value));
                }}
              />
              <div className="time-ticks">
                {[0, 6, 12, 18, 23]
                  .filter((index) => index <= maxHour)
                  .map((index) => (
                    <button
                      key={index}
                      onClick={() => {
                        setHour(index);
                        setPlaying(false);
                      }}
                    >
                      {index === 0
                        ? "Now"
                        : current?.hourly[index]
                          ? hourLabel(current.hourly[index].time)
                          : "+" + index + "h"}
                    </button>
                  ))}
              </div>
            </div>
            <button
              className="forecast-toggle"
              aria-label={expanded ? "Collapse forecast" : "Expand forecast"}
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              <span>{expanded ? "Hide insights" : "Show insights"}</span>
              <ChevronDown size={17} className={!expanded ? "turned" : ""} />
            </button>
          </div>
        </footer>

        <CommandPalette
          weather={weather}
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onPick={selectCity}
        />

        {drawer && (
          <div
            className="drawer-backdrop"
            onClick={(event) => {
              if (event.target === event.currentTarget) setDrawer(null);
            }}
          >
            <section
              className="data-drawer"
              role="dialog"
              aria-modal="true"
              aria-label={drawer}
              ref={drawerRef}
              tabIndex={-1}
            >
              <header>
                <div>
                  <span className="mini-label">VIEWEATHER WORKSPACE</span>
                  <h2>{drawer}</h2>
                </div>
                <button
                  className="round-button"
                  aria-label="Close workspace"
                  onClick={() => setDrawer(null)}
                >
                  <X size={21} />
                </button>
              </header>
              {drawer === "7-day forecast" ? (
                <section className="panel">
                  <div className="section-bar">
                    {current?.city.name}
                    <span className="tiny-tag">
                      {current?.source === "demo"
                        ? "Sample forecast"
                        : "Open-Meteo forecast"}
                    </span>
                  </div>
                  <div className="table-scroll">
                    <table className="daily-forecast-table">
                      <thead>
                        <tr>
                          {[
                            "Day",
                            "Conditions",
                            "High",
                            "Low",
                            "Rain",
                            "Peak wind",
                            "UV",
                          ].map((label) => (
                            <th key={label}>{label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {current?.daily.map((day) => (
                          <tr key={day.date}>
                            <td>{dayLabel(day.date)}</td>
                            <td>
                              <WeatherIcon code={day.code} size={20} />
                              {condition(day.code)}
                            </td>
                            <td>{t(day.high)}°</td>
                            <td>{t(day.low)}°</td>
                            <td>
                              {day.precipitationSum != null
                                ? day.precipitationSum.toFixed(1) + " mm"
                                : day.rainProbability + "%"}
                            </td>
                            <td>
                              {day.windMax != null ? Math.round(day.windMax) + " km/h" : "—"}
                            </td>
                            <td>{day.uv}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ) : drawer === "Atmosphere" ? (
                <div className="atmosphere-panel">
                  {current?.sun && <SunArc sun={current.sun} isDay={current.current.isDay} />}
                  {current?.moon && <MoonCard moon={current.moon} />}
                  {current?.airQuality && <AirQualityCard aq={current.airQuality} />}
                  <AlertStack
                    alerts={alerts}
                    onDismiss={(id) => setDismissed((d) => [...d, id])}
                  />
                  {current && (
                    <DetailGrid current={current.current} fahrenheit={fahrenheit} />
                  )}
                </div>
              ) : drawer === "Analytics" ? (
                <AnalyticsPanel analytics={analytics} fahrenheit={fahrenheit} />
              ) : (
                <PipelinePanel analytics={analytics} />
              )}
            </section>
          </div>
        )}
      </div>
    </InteractionLayer>
  );
}