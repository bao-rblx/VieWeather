/* ==========================================================================
   VieWeather — motion system (owner: motion)
   Public API is fixed by docs/UI_CONTRACT.md.
   ========================================================================== */
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import "./motion.css";

/* --------------------------------------------------------------------------
   Easings + colour helpers
   -------------------------------------------------------------------------- */

/** Fast-out, gentle settle. The house curve for entrances. */
export const easeOutCubic = (t: number): number => 1 - (1 - t) * (1 - t) * (1 - t);

/** Symmetric accelerate/decelerate, for A to B style moves. */
export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

const hexCache = new Map<string, [number, number, number]>();

function parseHex(hex: string): [number, number, number] {
  const cached = hexCache.get(hex);
  if (cached) return cached;
  let h = hex.trim().toLowerCase();
  if (h.startsWith("rgb")) {
    hexCache.set(hex, [255, 255, 255]);
    return [255, 255, 255];
  }
  h = h.replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = Number.parseInt(h.slice(0, 6), 16);
  const rgb: [number, number, number] = Number.isFinite(n)
    ? [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    : [255, 255, 255];
  if (hexCache.size > 64) hexCache.clear();
  hexCache.set(hex, rgb);
  return rgb;
}

/** '#f4bd5d', 0.4  ->  'rgba(244, 189, 93, 0.4)'. Parsed once per colour. */
export const rgba = (hex: string, alpha: number): string => {
  const c = parseHex(hex);
  return "rgba(" + c[0] + ", " + c[1] + ", " + c[2] + ", " + alpha + ")";
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* --------------------------------------------------------------------------
   Reduced motion
   -------------------------------------------------------------------------- */

/** Live read of the user's motion preference (safe during SSR / no window). */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* --------------------------------------------------------------------------
   tween — imperative rAF animation with a cancel handle
   -------------------------------------------------------------------------- */

export function tween(opts: {
  from: number;
  to: number;
  duration: number;
  ease?: (t: number) => number;
  onUpdate: (v: number) => void;
  onDone?: () => void;
}): () => void {
  const { from, to, duration, ease = easeOutCubic, onUpdate, onDone } = opts;
  if (typeof window === "undefined" || typeof requestAnimationFrame !== "function") {
    onUpdate(to);
    onDone?.();
    return () => {};
  }
  if (duration <= 0 || from === to || prefersReducedMotion()) {
    onUpdate(to);
    onDone?.();
    return () => {};
  }
  let raf = 0;
  let cancelled = false;
  const start = performance.now();
  const frame = (now: number) => {
    if (cancelled) return;
    const t = clamp01((now - start) / duration);
    onUpdate(t >= 1 ? to : from + (to - from) * ease(t));
    if (t < 1) raf = requestAnimationFrame(frame);
    else onDone?.();
  };
  raf = requestAnimationFrame(frame);
  return () => {
    cancelled = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
}

/* --------------------------------------------------------------------------
   AnimatedNumber — interpolates from the previously shown value to the next.
   The text is written straight to the DOM node, so a screen full of counters
   costs zero React renders per animation frame.
   -------------------------------------------------------------------------- */

function formatNumber(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return "—";
  const d = Math.max(0, Math.min(4, decimals));
  let n = value;
  if (Math.abs(n) < Math.pow(10, -d) / 2) n = 0;
  const fixed = n.toFixed(d);
  if (Math.abs(n) < 1000) return fixed;
  const negative = fixed.charAt(0) === "-";
  const body = negative ? fixed.slice(1) : fixed;
  const dot = body.indexOf(".");
  const int = dot === -1 ? body : body.slice(0, dot);
  const frac = dot === -1 ? "" : body.slice(dot);
  let out = "";
  for (let i = 0; i < int.length; i++) {
    const left = int.length - i;
    out += int.charAt(i);
    if (left > 1 && left % 3 === 0) out += ",";
  }
  return (negative ? "-" : "") + out + frac;
}

export function AnimatedNumber(props: {
  value: number;
  decimals?: number;
  duration?: number;
  className?: string;
}) {
  const { value, decimals = 0, duration = 700, className } = props;
  const ref = useRef<HTMLSpanElement | null>(null);
  const shown = useRef<number>(value);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = Number.isFinite(value) ? value : 0;
    if (prefersReducedMotion()) {
      shown.current = target;
      el.textContent = formatNumber(value, decimals);
      return;
    }
    const from = shown.current;
    if (from === target) {
      el.textContent = formatNumber(target, decimals);
      return;
    }
    return tween({
      from,
      to: target,
      duration,
      ease: easeOutCubic,
      onUpdate: (v) => {
        shown.current = v;
        const text = formatNumber(v, decimals);
        if (el.textContent !== text) el.textContent = text;
      },
      onDone: () => {
        shown.current = target;
        const text = formatNumber(target, decimals);
        if (el.textContent !== text) el.textContent = text;
      },
    });
  }, [value, decimals, duration]);

  return (
    <span ref={ref} className={className ? "vw-num " + className : "vw-num"}>
      {formatNumber(value, decimals)}
    </span>
  );
}

/* --------------------------------------------------------------------------
   useInView — shared IntersectionObserver plumbing for Reveal / Stagger
   -------------------------------------------------------------------------- */

function useInView(once: boolean) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            if (once) io.disconnect();
          } else if (!once) {
            setShown(false);
          }
        }
      },
      // threshold 0 (any pixel) so panels taller than the viewport still fire
      { threshold: 0, rootMargin: "0px 0px -6% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [once]);

  return { ref, shown };
}

/* --------------------------------------------------------------------------
   Reveal
   -------------------------------------------------------------------------- */

export function Reveal(props: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
  as?: "div" | "section" | "li" | "tr";
  once?: boolean;
}) {
  const { children, delay = 0, y = 14, className, as = "div", once = true } = props;
  const { ref, shown } = useInView(once);
  const Tag = as as "div";
  const style = {
    "--vw-reveal-y": String(y) + "px",
    "--vw-reveal-delay": String(delay) + "ms",
  } as CSSProperties;
  return (
    <Tag
      ref={ref as React.Ref<HTMLDivElement>}
      className={"vw-reveal" + (shown ? " is-in" : "") + (className ? " " + className : "")}
      style={style}
    >
      {children}
    </Tag>
  );
}

/* --------------------------------------------------------------------------
   Stagger
   -------------------------------------------------------------------------- */

type StaggerChildProps = { className?: string; style?: CSSProperties };

export function Stagger(props: {
  children: ReactNode;
  gap?: number;
  delay?: number;
  className?: string;
}) {
  const { children, gap = 55, delay = 0, className } = props;
  const { ref, shown } = useInView(true);
  const style = {
    "--vw-stagger-gap": String(gap) + "ms",
    "--vw-stagger-delay": String(delay) + "ms",
  } as CSSProperties;

  return (
    <div
      ref={ref as React.Ref<HTMLDivElement>}
      className={"vw-stagger" + (shown ? " is-in" : "") + (className ? " " + className : "")}
      style={style}
    >
      {Children.toArray(children).map((child, index) => {
        if (!isValidElement(child)) return child;
        const el = child as ReactElement<StaggerChildProps>;
        return cloneElement(el, {
          className:
            "vw-stagger-item" + (el.props.className ? " " + el.props.className : ""),
          style: { ...el.props.style, "--vw-stagger-i": index } as CSSProperties,
        });
      })}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Ripple
   -------------------------------------------------------------------------- */

let rippleLayer: HTMLDivElement | null = null;

function ensureRippleLayer(): HTMLDivElement {
  if (rippleLayer && rippleLayer.isConnected) return rippleLayer;
  const el = document.createElement("div");
  el.className = "vw-ripple-layer";
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  rippleLayer = el;
  return el;
}

const RIPPLE_SELECTOR = 'button, [role="button"], [data-vw-ripple]';

function spawnRipple(host: HTMLElement, cx: number, cy: number) {
  if (typeof document === "undefined") return;
  const layer = ensureRippleLayer();
  const rect = host.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  const reach = Math.hypot(
    Math.max(cx - rect.left, rect.right - cx),
    Math.max(cy - rect.top, rect.bottom - cy),
  );
  const size = Math.min(260, Math.max(46, reach * 2.1));
  const span = document.createElement("span");
  span.className = "vw-ripple";
  span.style.setProperty("--vw-x", cx.toFixed(1) + "px");
  span.style.setProperty("--vw-y", cy.toFixed(1) + "px");
  span.style.setProperty("--vw-size", size.toFixed(1) + "px");
  layer.appendChild(span);
  const kill = () => {
    if (span.isConnected) span.remove();
  };
  span.addEventListener("animationend", kill, { once: true });
  window.setTimeout(kill, 900);
}

/** Programmatic ripple for surfaces that are not buttons. */
export function ripple(event: ReactMouseEvent | MouseEvent, host?: HTMLElement): void {
  if (prefersReducedMotion()) return;
  const target =
    host ??
    ((event.currentTarget as HTMLElement | null) ??
      ((event.target as HTMLElement | null)?.closest?.(RIPPLE_SELECTOR) as HTMLElement | null));
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const cx =
    Number.isFinite(event.clientX) && event.clientX > 0 ? event.clientX : rect.left + rect.width / 2;
  const cy =
    Number.isFinite(event.clientY) && event.clientY > 0 ? event.clientY : rect.top + rect.height / 2;
  spawnRipple(target, cx, cy);
}

/* --------------------------------------------------------------------------
   InteractionLayer — delegated ripple + press for the whole app
   -------------------------------------------------------------------------- */

export function InteractionLayer(props: { children: ReactNode }) {
  useEffect(() => {
    if (typeof window === "undefined") return;

    let pressed: HTMLElement | null = null;
    let releaseTimer = 0;

    const clearTimer = () => {
      if (releaseTimer) {
        window.clearTimeout(releaseTimer);
        releaseTimer = 0;
      }
    };

    const release = (immediate: boolean) => {
      clearTimer();
      const el = pressed;
      pressed = null;
      if (!el) return;
      if (immediate) el.classList.remove("vw-press");
      else releaseTimer = window.setTimeout(() => el.classList.remove("vw-press"), 90);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      const origin = event.target as Element | null;
      const host = origin?.closest?.(RIPPLE_SELECTOR) as HTMLElement | null;
      if (!host) return;
      if (host.closest("[data-vw-no-ripple]")) return;
      if (host.hasAttribute("disabled") || host.getAttribute("aria-disabled") === "true") return;
      if (prefersReducedMotion()) return;
      spawnRipple(host, event.clientX, event.clientY);
      if (pressed && pressed !== host) pressed.classList.remove("vw-press");
      pressed = host;
      host.classList.add("vw-press");
    };

    const onPointerUp = () => release(false);
    const onBlur = () => release(true);

    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    window.addEventListener("pointercancel", onPointerUp, { passive: true });
    window.addEventListener("blur", onBlur);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("blur", onBlur);
      clearTimer();
      pressed?.classList.remove("vw-press");
    };
  }, []);

  return <div className="vw-interaction">{props.children}</div>;
}
