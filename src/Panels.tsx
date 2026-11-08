// Panels.tsx — owner: panels. Rich weather data surfaces.
// All exported names/signatures match docs/UI_CONTRACT.md.
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Cloud,
  CloudLightning,
  CloudRain,
  CornerDownLeft,
  Droplets,
  Eye,
  Gauge,
  Info,
  Search,
  Sparkles,
  Sun,
  Sunrise,
  Sunset,
  Wind,
  X,
} from "lucide-react";
import {
  aqiBand,
  condition,
  hourLabel,
  normalize,
  temperature,
  type AirQuality,
  type Hour,
  type Metric,
  type MoonPhase,
  type SunTimes,
  type Weather,
  type WeatherAlert,
} from "./types";
import "./panels.css";

/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduce, setReduce] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const on = () => setReduce(mql.matches);
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, []);
  return reduce;
}

/** rAF tween toward a scalar target; honours reduced motion. */
function useAnimated(target: number, duration = 900): number {
  const reduce = usePrefersReducedMotion();
  const [value, setValue] = useState(reduce ? target : 0);
  const current = useRef(reduce ? target : 0);
  useEffect(() => {
    if (reduce) {
      current.current = target;
      setValue(target);
      return;
    }
    const origin = current.current;
    if (Math.abs(origin - target) < 1e-6) {
      setValue(target);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const v = origin + (target - origin) * easeOutCubic(t);
      current.current = v;
      setValue(v);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, reduce]);
  return value;
}

const fmtClock = (iso: string): string => {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : hourLabel(iso);
};

function WeatherGlyph({ code, size = 16 }: { code: number; size?: number }) {
  const Icon = code >= 95 ? CloudLightning : code >= 51 ? CloudRain : code === 0 ? Sun : Cloud;
  return <Icon size={size} />;
}

/** Catmull-Rom -> cubic bezier smoothing for a compact SVG line. */
function smoothPath(pts: Array<[number, number]>): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return "M " + pts[0][0] + " " + pts[0][1];
  let d = "M " + pts[0][0] + " " + pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += " C " + c1x + " " + c1y + " " + c2x + " " + c2y + " " + p2[0] + " " + p2[1];
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* moon disc (shared by SunArc + MoonCard)                             */
/* ------------------------------------------------------------------ */

/** Lit-region path for a moon phase 0..1 (0 new, .5 full, 1 new). */
function moonLitPath(r: number, p: number): string {
  const phase = ((p % 1) + 1) % 1;
  const cosA = Math.cos(2 * Math.PI * phase);
  const waxing = phase < 0.5;
  const outerSweep = waxing ? 1 : 0;
  const termSweep = waxing ? (cosA > 0 ? 0 : 1) : (cosA > 0 ? 1 : 0);
  const rx = Math.abs(r * cosA);
  return (
    "M 0 " +
    -r +
    " A " +
    r +
    " " +
    r +
    " 0 0 " +
    outerSweep +
    " 0 " +
    r +
    " A " +
    rx +
    " " +
    r +
    " 0 0 " +
    termSweep +
    " 0 " +
    -r +
    " Z"
  );
}

function MoonDisc({ phase, r }: { phase: number; r: number }) {
  const clipId = "moonclip" + useId().replace(/[^a-zA-Z0-9]/g, "");
  return (
    <g>
      <circle r={r} className="panels-moon-base" />
      <path d={moonLitPath(r, phase)} className="panels-moon-lit" />
      <g clipPath={"url(#" + clipId + ")"}>
        <circle cx={-r * 0.28} cy={-r * 0.22} r={r * 0.16} className="panels-moon-crater" />
        <circle cx={r * 0.2} cy={r * 0.3} r={r * 0.11} className="panels-moon-crater" />
        <circle cx={r * 0.34} cy={-r * 0.24} r={r * 0.08} className="panels-moon-crater" />
      </g>
      <defs>
        <clipPath id={clipId}>
          <circle r={r} />
        </clipPath>
      </defs>
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* 1. SunArc                                                           */
/* ------------------------------------------------------------------ */

export function SunArc({ sun, isDay }: { sun: SunTimes; isDay: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);

  const sunrise = Date.parse(sun.sunrise);
  const sunset = Date.parse(sun.sunset);
  const span = Math.max(1, sunset - sunrise);
  const dayFrac = clamp(span / 86400000, 0.12, 0.88);

  let u = ((now - sunrise) / 86400000) % 1;
  if (!Number.isFinite(u)) u = 0.5;
  if (u < 0) u += 1;

  const animatedU = useAnimated(u, 1200);
  const uu = clamp(animatedU, 0, 1);
  const phi =
    uu <= dayFrac
      ? Math.PI * (1 - uu / dayFrac)
      : -Math.PI * ((uu - dayFrac) / (1 - dayFrac));

  const CX = 160;
  const CY = 104;
  const RX = 136;
  const RY = 74;
  const x = CX + RX * Math.cos(phi);
  const yRaw = CY - RY * Math.sin(phi);
  const progress = clamp(uu / dayFrac, 0, 1);
  const isNightNow = u > dayFrac;
  const y = isNightNow ? CY - 1 : yRaw;

  const arc =
    "M " + (CX - RX) + " " + CY + " A " + RX + " " + RY + " 0 0 1 " + (CX + RX) + " " + CY;

  const hours = Math.floor(sun.dayLength / 3600);
  const mins = Math.round((sun.dayLength % 3600) / 60);

  return (
    <div className={"panels-sunarc" + (isNightNow ? " is-night" : "")}>
      <div className="panels-sunarc-head">
        <span className="panels-mini">{isDay && !isNightNow ? "SUN & DAYLIGHT" : "SUN & NIGHT"}</span>
        <span className="panels-sunarc-len">
          {hours}h {mins}m daylight
        </span>
      </div>
      <svg
        viewBox="0 0 320 132"
        className="panels-sunarc-svg"
        role="img"
        aria-label="Sun path from sunrise to sunset"
      >
        <path d={arc} className="panels-sun-track" pathLength={100} />
        <path
          d={arc}
          className="panels-sun-progress"
          pathLength={100}
          style={{ strokeDasharray: progress * 100 + " 100" }}
        />
        <line x1={CX - RX - 16} y1={CY} x2={CX + RX + 16} y2={CY} className="panels-sun-horizon" />
        <g
          className="panels-sun-disc"
          style={{ transform: "translate(" + x + "px," + y + "px)" }}
        >
          <circle r="24" className="panels-sun-halo" />
          {isNightNow ? (
            <g className="panels-sun-moon">
              <MoonDisc phase={0.62} r={7.2} />
            </g>
          ) : (
            <circle r="7.4" className="panels-sun-core" />
          )}
        </g>
        <rect x="0" y={CY} width="320" height={132 - CY} className="panels-sun-ground" />
      </svg>
      <div className="panels-sunarc-foot">
        <span>
          <Sunrise size={12} />
          <b>{fmtClock(sun.sunrise)}</b>
          <em>Sunrise</em>
        </span>
        <span className="panels-sunarc-noon">Solar noon {fmtClock(sun.solarNoon)}</span>
        <span>
          <Sunset size={12} />
          <b>{fmtClock(sun.sunset)}</b>
          <em>Sunset</em>
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 2. HourlyChart                                                      */
/* ------------------------------------------------------------------ */

const CHART_META: Record<Metric, { color: string; label: string; unit: string }> = {
  temperature: { color: "#f4bd5d", label: "Temperature", unit: "°" },
  precipitation: { color: "#8dbdd7", label: "Precipitation", unit: " mm" },
  wind: { color: "#8fcaab", label: "Wind", unit: " km/h" },
};

export function HourlyChart({
  hourly,
  hour,
  fahrenheit,
  metric,
  onScrub,
}: {
  hourly: Hour[];
  hour: number;
  fahrenheit: boolean;
  metric: Metric;
  onScrub: (hour: number) => void;
}) {
  const reduce = usePrefersReducedMotion();
  const gid = "chart" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(680);
  const [drawn, setDrawn] = useState(reduce);
  const [hover, setHover] = useState<number | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0].contentRect.width;
      if (cw > 0) setW(Math.round(cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (reduce) {
      setDrawn(true);
      return;
    }
    setDrawn(false);
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, [reduce, metric, hourly.length]);

  const data = useMemo(() => hourly.slice(0, 24), [hourly]);
  const meta = CHART_META[metric];
  const n = data.length;

  const values = useMemo(
    () =>
      data.map((h) =>
        metric === "temperature"
          ? temperature(h.temperature, fahrenheit)
          : metric === "precipitation"
            ? h.precipitation
            : h.wind,
      ),
    [data, metric, fahrenheit],
  );

  const H = 176;
  const padL = 12;
  const padR = 12;
  const padT = 24;
  const padB = 26;
  const plotW = Math.max(10, w - padL - padR);
  const plotH = H - padT - padB;

  let lo = Math.min.apply(null, values.length ? values : [0]);
  let hi = Math.max.apply(null, values.length ? values : [1]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (hi - lo < 1e-6) hi = lo + 1;
  const pad = (hi - lo) * 0.16;
  const dmin = lo - pad;
  const dmax = hi + pad;
  const stepX = n > 1 ? plotW / (n - 1) : plotW;
  const X = (i: number) => padL + i * stepX;
  const Y = (v: number) => padT + (1 - (v - dmin) / (dmax - dmin)) * plotH;

  const pts: Array<[number, number]> = values.map((v, i) => [X(i), Y(v)]);
  const line = smoothPath(pts);
  const area =
    line +
    " L " +
    X(Math.max(0, n - 1)) +
    " " +
    (H - padB) +
    " L " +
    X(0) +
    " " +
    (H - padB) +
    " Z";

  const active = clamp(hour >= 0 && hour < n ? hour : 0, 0, Math.max(0, n - 1));
  const shown = hover == null ? active : hover;

  const idxFromEvent = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / Math.max(1, rect.width)) * w;
    return clamp(Math.round((px - padL) / Math.max(1, stepX)), 0, Math.max(0, n - 1));
  };

  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    const i = idxFromEvent(e);
    setHover(i);
    onScrub(i);
  };
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const i = idxFromEvent(e);
    setHover(i);
    if (dragging.current) onScrub(i);
  };
  const onUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  const onLeave = () => {
    if (!dragging.current) setHover(null);
  };

  const formatValue = (v: number) =>
    metric === "temperature"
      ? String(Math.round(v))
      : metric === "precipitation"
        ? v.toFixed(1)
        : String(Math.round(v));

  const gridLines = [0.25, 0.5, 0.75];
  const tickIdx: number[] = [];
  for (let i = 0; i < n; i += 6) tickIdx.push(i);
  if (n > 0 && n - 1 - tickIdx[tickIdx.length - 1] >= 3) tickIdx.push(n - 1);

  const tipX = X(shown);
  const tipY = Y(values[shown] || 0);
  const allDry =
    metric === "precipitation" &&
    values.length > 0 &&
    Math.max.apply(null, values) < 0.05;

  return (
    <div className="panels-chart">
      <div className="panels-chart-head">
        <div>
          <span className="panels-mini">NEXT 24 HOURS</span>
          <div className="panels-chart-metric">
            <i className="panels-chart-dot" style={{ background: meta.color }} />
            {meta.label}
          </div>
        </div>
        {n > 0 && (
          <div className="panels-chart-now">
            {formatValue(values[shown] || 0)}
            <small>{meta.unit}</small>
          </div>
        )}
      </div>
      <div className="panels-chart-wrap" ref={wrapRef}>
        {n === 0 ? (
          <div className="panels-chart-empty">Waiting for hourly data…</div>
        ) : (
          <svg
            className={"panels-chart-svg" + (drawn ? " is-drawn" : "")}
            viewBox={"0 0 " + w + " " + H}
            style={{ height: H }}
            role="img"
            aria-label={meta.label + " for the next 24 hours"}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={onLeave}
          >
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={meta.color} stopOpacity="0.32" />
                <stop offset="0.65" stopColor={meta.color} stopOpacity="0.06" />
                <stop offset="1" stopColor={meta.color} stopOpacity="0" />
              </linearGradient>
            </defs>
            {gridLines.map((g) => (
              <line
                key={g}
                x1={padL}
                y1={padT + g * plotH}
                x2={w - padR}
                y2={padT + g * plotH}
                className="panels-chart-grid"
              />
            ))}
            <path d={area} fill={"url(#" + gid + ")"} className="panels-chart-area" />
            <path
              d={line}
              className="panels-chart-line"
              pathLength={1}
              style={{ stroke: meta.color }}
            />
            <line
              x1={X(active)}
              y1={padT}
              x2={X(active)}
              y2={H - padB}
              className="panels-chart-cursor"
            />
            <circle cx={X(active)} cy={Y(values[active] || 0)} r="3.4" className="panels-chart-dotmark" />
            {tickIdx.map((i) => (
              <text key={i} x={X(i)} y={H - 8} className="panels-chart-axis" textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>
                {i === 0 ? "Now" : hourLabel(data[i].time)}
              </text>
            ))}
          </svg>
        )}
        {allDry && <div className="panels-chart-note">No precipitation expected</div>}
        {n > 0 && (
          <div className="panels-chart-tip" style={{ left: tipX, top: tipY - 12 }}>
            <b>
              {formatValue(values[shown] || 0)}
              {meta.unit}
            </b>
            <span>{shown === 0 ? "Now" : hourLabel(data[shown].time)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 3. AirQualityCard                                                   */
/* ------------------------------------------------------------------ */

const AQ_SEGMENTS = [
  { max: 50, color: "#5ec98a" },
  { max: 100, color: "#e8c569" },
  { max: 150, color: "#e79a5c" },
  { max: 200, color: "#dd6a5f" },
  { max: 300, color: "#b3669e" },
  { max: 500, color: "#9d4b5f" },
];

export function AirQualityCard({ aq, compact }: { aq: AirQuality; compact?: boolean }) {
  const band = aqiBand(aq.aqi);
  let seg = AQ_SEGMENTS.findIndex((s) => aq.aqi <= s.max);
  if (seg < 0) seg = AQ_SEGMENTS.length - 1;
  const frac = clamp(aq.aqi / 300, 0.02, 1);
  const R = 26;
  const C = 2 * Math.PI * R;

  const pollutants = [
    { k: "PM2.5", v: aq.pm25, max: 75, unit: "µg/m³" },
    { k: "PM10", v: aq.pm10, max: 150, unit: "µg/m³" },
    { k: "O₃", v: aq.ozone, max: 180, unit: "µg/m³" },
    { k: "NO₂", v: aq.no2, max: 200, unit: "µg/m³" },
    { k: "SO₂", v: aq.so2, max: 350, unit: "µg/m³" },
    { k: "CO", v: aq.co, max: 4000, unit: "µg/m³" },
  ];

  return (
    <div className={"panels-aq" + (compact ? " is-compact" : "")}>
      <header className="panels-aq-head">
        <span className="panels-mini">AIR QUALITY</span>
        <span className="panels-aq-cat">{aq.category || band.label}</span>
      </header>
      <div className="panels-aq-main">
        <div className="panels-aq-num" style={{ color: band.color }}>
          {Math.round(aq.aqi)}
          <small>US AQI</small>
        </div>
        <div className="panels-aq-band" style={{ color: band.color }}>
          {band.label}
        </div>
        <svg viewBox="0 0 64 64" className="panels-aq-ring" aria-hidden="true">
          <circle cx="32" cy="32" r={R} className="track" />
          <circle
            cx="32"
            cy="32"
            r={R}
            className="val"
            style={{
              stroke: band.color,
              strokeDasharray: frac * C + " " + C,
            }}
          />
        </svg>
      </div>
      <div className="panels-aq-bar">
        {AQ_SEGMENTS.map((s, i) => (
          <span
            key={s.max}
            style={{ color: s.color }}
            className={i === seg ? "is-on" : ""}
          />
        ))}
      </div>
      <div className="panels-aq-scale">
        <span>0</span>
        <span>50</span>
        <span>100</span>
        <span>150</span>
        <span>200</span>
        <span>300+</span>
      </div>
      {!compact && (
        <div className="panels-aq-pollutants">
          {pollutants.map((p) => {
            const ratio = clamp((p.v || 0) / p.max, 0, 1);
            const display = String(Math.round(p.v || 0));
            return (
              <div className="panels-aq-poll" key={p.k}>
                <div className="row">
                  <span>{p.k}</span>
                  <b>
                    {display}
                    <em>{p.unit}</em>
                  </b>
                </div>
                <div className="track">
                  <div
                    className="fill"
                    style={{ width: ratio * 100 + "%", background: band.color }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 4. MoonCard                                                         */
/* ------------------------------------------------------------------ */

export function MoonCard({ moon }: { moon: MoonPhase }) {
  return (
    <div className="panels-moon">
      <span className="panels-mini">MOON</span>
      <div className="panels-moon-body">
        <svg viewBox="-40 -40 80 80" className="panels-moon-svg" role="img" aria-label={"Moon phase: " + moon.name}>
          <circle r="33" className="panels-moon-halo" />
          <MoonDisc phase={moon.phase} r={30} />
        </svg>
        <div className="panels-moon-info">
          <strong>
            {Math.round(moon.illumination)}
            <span>%</span>
          </strong>
          <em>illuminated</em>
          <div className="panels-moon-name">{moon.name}</div>
        </div>
      </div>
      <div className="panels-moon-times">
        <span>
          <ArrowUp size={12} />
          {fmtClock(moon.rise)}
          <small>Rise</small>
        </span>
        <span>
          <ArrowDown size={12} />
          {fmtClock(moon.set)}
          <small>Set</small>
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 5. AlertStack                                                       */
/* ------------------------------------------------------------------ */

const ALERT_META: Record<
  WeatherAlert["severity"],
  { color: string; soft: string; label: string; Icon: ComponentType<{ size?: number }> }
> = {
  info: { color: "#8dbdd7", soft: "rgba(141,189,215,0.16)", label: "Information", Icon: Info },
  watch: { color: "#e8c569", soft: "rgba(232,197,105,0.16)", label: "Watch", Icon: Eye },
  warning: { color: "#d96c4e", soft: "rgba(217,108,78,0.18)", label: "Warning", Icon: AlertTriangle },
  severe: { color: "#dd6a5f", soft: "rgba(221,106,95,0.2)", label: "Severe", Icon: AlertTriangle },
};

export function AlertStack({
  alerts,
  onDismiss,
}: {
  alerts: WeatherAlert[];
  onDismiss: (id: string) => void;
}) {
  const reduce = usePrefersReducedMotion();
  if (!alerts.length)
    return (
      <div className="panels-alerts panels-alerts-empty">
        <Sparkles size={14} />
        All clear — no active weather alerts.
      </div>
    );
  return (
    <div className="panels-alerts">
      {alerts.map((a, i) => {
        const meta = ALERT_META[a.severity] || ALERT_META.info;
        const Icon = meta.Icon;
        return (
          <article
            key={a.id}
            className={"panels-alert sev-" + a.severity}
            style={
              {
                "--panels-alert-color": meta.color,
                "--panels-alert-soft": meta.soft,
                animationDelay: reduce ? undefined : i * 80 + "ms",
              } as CSSProperties
            }
          >
            <span className="panels-alert-rail" />
            <span className="panels-alert-icon">
              <Icon size={15} />
            </span>
            <div className="panels-alert-main">
              <div className="panels-alert-top">
                <b>{a.title}</b>
                <span className="panels-alert-sev">{meta.label}</span>
              </div>
              <p>{a.body}</p>
              <div className="panels-alert-meta">
                <span>{a.region}</span>
                <span>
                  {fmtClock(a.starts)} – {fmtClock(a.ends)}
                </span>
              </div>
            </div>
            <button
              className="panels-alert-x"
              aria-label={"Dismiss alert: " + a.title}
              onClick={() => onDismiss(a.id)}
            >
              <X size={14} />
            </button>
          </article>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 6. DetailGrid                                                       */
/* ------------------------------------------------------------------ */

function uvMeta(uv: number | undefined): { label: string; color: string } {
  if (uv == null) return { label: "—", color: "#8dbdd7" };
  if (uv <= 2) return { label: "Low", color: "#8fcaab" };
  if (uv <= 5) return { label: "Moderate", color: "#e8c569" };
  if (uv <= 7) return { label: "High", color: "#e79a5c" };
  if (uv <= 10) return { label: "Very high", color: "#dd6a5f" };
  return { label: "Extreme", color: "#b3669e" };
}

export function DetailGrid({
  current,
  fahrenheit,
}: {
  current: Weather["current"];
  fahrenheit: boolean;
}) {
  const t = (v: number) => temperature(v, fahrenheit);
  const uv = uvMeta(current.uvIndex);
  const cells = [
    {
      Icon: Gauge,
      label: "Pressure",
      value: String(Math.round(current.pressure)),
      unit: "hPa",
      tint: "#abc7d6",
    },
    {
      Icon: Eye,
      label: "Visibility",
      value:
        current.visibility != null
          ? (current.visibility >= 100
              ? current.visibility / 1000
              : current.visibility
            ).toFixed(1)
          : "—",
      unit: current.visibility != null ? "km" : "",
      tint: "#8dbdd7",
    },
    {
      Icon: Droplets,
      label: "Dew point",
      value: current.dewPoint != null ? String(t(current.dewPoint)) : "—",
      unit: current.dewPoint != null ? "°" : "",
      tint: "#8dbdd7",
    },
    {
      Icon: Sun,
      label: "UV index",
      value: current.uvIndex != null ? String(Math.round(current.uvIndex)) : "—",
      unit: "",
      note: uv.label,
      tint: uv.color,
    },
    {
      Icon: Wind,
      label: "Wind gust",
      value: current.windGust != null ? String(Math.round(current.windGust)) : "—",
      unit: current.windGust != null ? "km/h" : "",
      tint: "#8fcaab",
    },
    {
      Icon: Cloud,
      label: "Cloud cover",
      value: String(Math.round(current.cloudCover)),
      unit: "%",
      tint: "#abc7d6",
    },
  ];
  return (
    <div className="panels-detail">
      {cells.map((c) => {
        const Icon = c.Icon;
        return (
          <div className="panels-detail-cell" key={c.label}>
            <span className="panels-detail-icon" style={{ color: c.tint }}>
              <Icon size={16} />
            </span>
            <div>
              <strong>
                {c.value}
                {c.unit ? <small>{c.unit}</small> : null}
              </strong>
              <span>
                {c.label}
                {c.note ? <em style={{ color: c.tint }}> · {c.note}</em> : null}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 7. CommandPalette                                                   */
/* ------------------------------------------------------------------ */

export function CommandPalette({
  weather,
  open,
  onClose,
  onPick,
}: {
  weather: Weather[];
  open: boolean;
  onClose: () => void;
  onPick: (cityId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      prevFocus.current = document.activeElement as HTMLElement | null;
      setQuery("");
      setActive(0);
      const id = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(id);
    }
    prevFocus.current?.focus?.();
    return undefined;
  }, [open]);

  const results = useMemo(() => {
    const q = normalize(query.trim());
    const scored = weather
      .map((w) => {
        const name = normalize(w.city.name);
        const region = normalize(w.city.region);
        let score = 0;
        if (!q) score = 1;
        else if (name === q) score = 100;
        else if (name.startsWith(q)) score = 80;
        else if (name.includes(q)) score = 40;
        else if (region.includes(q)) score = 20;
        return { w, score };
      })
      .filter((x) => x.score > 0);
    scored.sort(
      (a, b) => b.score - a.score || a.w.city.name.localeCompare(b.w.city.name),
    );
    return scored.map((x) => x.w);
  }, [weather, query]);

  const rows = useMemo(() => {
    const out: Array<
      { kind: "group"; region: string } | { kind: "item"; w: Weather; index: number }
    > = [];
    let index = 0;
    const grouped = new Map<string, Weather[]>();
    for (const w of results) {
      if (!grouped.has(w.city.region)) grouped.set(w.city.region, []);
      grouped.get(w.city.region)!.push(w);
    }
    for (const [region, items] of grouped) {
      out.push({ kind: "group", region });
      for (const w of items) {
        out.push({ kind: "item", w, index: index++ });
      }
    }
    return out;
  }, [results]);

  const activeClamped = clamp(active, 0, Math.max(0, results.length - 1));

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }, [activeClamped, open]);

  if (!open) return null;

  const pick = (w: Weather | undefined) => {
    if (!w) return;
    onPick(w.city.id);
    onClose();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      pick(results[activeClamped]);
      return;
    }
    if (e.key === "Tab") {
      const panel = panelRef.current;
      if (!panel) return;
      const f = panel.querySelectorAll<HTMLElement>(
        'input, button, [href], [tabindex]:not([tabindex="-1"])',
      );
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div
      className="panels-cmdk-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="panels-cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Search cities"
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <div className="panels-cmdk-search">
          <Search size={17} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search cities or regions…"
            aria-label="Search cities"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd>ESC</kbd>
        </div>
        <div className="panels-cmdk-list" ref={listRef}>
          {rows.map((row) =>
            row.kind === "group" ? (
              <div className="panels-cmdk-grouphead" key={"g-" + row.region}>
                {row.region}
              </div>
            ) : (
              <button
                key={row.w.city.id}
                type="button"
                data-active={row.index === activeClamped}
                className={"panels-cmdk-item" + (row.index === activeClamped ? " is-active" : "")}
                onMouseEnter={() => setActive(row.index)}
                onPointerDown={(e) => {
                  e.preventDefault();
                  pick(row.w);
                }}
              >
                <span className="glyph">
                  <WeatherGlyph code={row.w.current.code} size={17} />
                </span>
                <span className="meta">
                  <span className="name">{row.w.city.name}</span>
                  <span className="sub">
                    {row.w.city.region} · {condition(row.w.current.code)}
                  </span>
                </span>
                <span className="temp">
                  {temperature(row.w.current.temperature, false)}°
                </span>
              </button>
            ),
          )}
          {!results.length && (
            <div className="panels-cmdk-empty">No cities match “{query}”.</div>
          )}
        </div>
        <footer className="panels-cmdk-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
          <span className="panels-cmdk-brand">
            <CornerDownLeft size={12} /> VieWeather
          </span>
        </footer>
      </div>
    </div>
  );
}
