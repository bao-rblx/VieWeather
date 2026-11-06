/* ==========================================================================
   VieWeather — ambient weather canvas (owner: motion)

   A single full-bleed 2D canvas that sits above the WebGL map and below every
   panel, painting the weather of the focused city: rain, drizzle, snow, fog,
   drifting cloud, sun shafts, night stars and lightning.

   Performance contract
   --------------------
   * one rAF loop, hard-capped to ~30 fps (a background atmosphere does not
     need 60).
   * zero allocations inside the frame: every particle lives in a pre-allocated
     Float32Array pool, and every colour string is a module constant.
   * dpr aware but capped at 1.75 (full-screen fill rate is the real cost).
   * pauses on document.hidden, and never runs at all under reduced motion
     (it paints one static gradient instead).
   * condition changes cross-fade over 750 ms by interpolating feature weights,
     so nothing ever pops.
   ========================================================================== */
import { useEffect, useRef } from "react";
import "./motion.css";
import { easeInOutCubic, prefersReducedMotion } from "./motion";

/* --------------------------------------------------------------------------
   Condition model
   -------------------------------------------------------------------------- */

type Kind =
  | "clear-day"
  | "clear-night"
  | "partly-day"
  | "partly-night"
  | "overcast"
  | "fog"
  | "drizzle"
  | "rain"
  | "snow"
  | "thunder";

type Feature = {
  rain: number;
  drizzle: number;
  snow: number;
  cloud: number;
  fog: number;
  shaft: number;
  star: number;
  bolt: number;
  warm: number;
  cool: number;
};

const feature = (
  rain: number,
  drizzle: number,
  snow: number,
  cloud: number,
  fog: number,
  shaft: number,
  star: number,
  bolt: number,
  warm: number,
  cool: number,
): Feature => ({ rain, drizzle, snow, cloud, fog, shaft, star, bolt, warm, cool });

const FEATURES: Record<Kind, Feature> = {
  "clear-day": feature(0, 0, 0, 0.18, 0.06, 1, 0, 0, 1, 0),
  "clear-night": feature(0, 0, 0, 0.08, 0, 0, 1, 0, 0, 0.55),
  "partly-day": feature(0, 0, 0, 0.62, 0.05, 0.42, 0, 0, 0.5, 0),
  "partly-night": feature(0, 0, 0, 0.55, 0, 0, 0.62, 0, 0, 0.4),
  overcast: feature(0, 0, 0, 1, 0.12, 0, 0, 0, 0, 0.3),
  fog: feature(0, 0, 0, 0.3, 1, 0, 0, 0, 0, 0.12),
  drizzle: feature(0, 1, 0, 0.55, 0.34, 0, 0, 0, 0, 0.2),
  rain: feature(1, 0, 0, 0.62, 0.14, 0, 0, 0, 0, 0.26),
  snow: feature(0, 0, 1, 0.55, 0.1, 0, 0, 0, 0, 0.3),
  thunder: feature(1.1, 0, 0, 0.9, 0.16, 0, 0.15, 1, 0, 0.34),
};

function kindFor(code: number, isDay: boolean): Kind {
  if (code >= 95) return "thunder";
  if (code >= 85) return "snow";
  if (code >= 80) return "rain";
  if (code >= 71) return "snow";
  if (code >= 61) return "rain";
  if (code >= 51) return "drizzle";
  if (code >= 45) return "fog";
  if (code === 3) return "overcast";
  if (code === 2) return isDay ? "partly-day" : "partly-night";
  return isDay ? "clear-day" : "clear-night";
}

const newFeature = (): Feature => feature(0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

function copyInto(out: Feature, src: Feature) {
  out.rain = src.rain;
  out.drizzle = src.drizzle;
  out.snow = src.snow;
  out.cloud = src.cloud;
  out.fog = src.fog;
  out.shaft = src.shaft;
  out.star = src.star;
  out.bolt = src.bolt;
  out.warm = src.warm;
  out.cool = src.cool;
}

function lerpInto(out: Feature, a: Feature, b: Feature, t: number) {
  out.rain = a.rain + (b.rain - a.rain) * t;
  out.drizzle = a.drizzle + (b.drizzle - a.drizzle) * t;
  out.snow = a.snow + (b.snow - a.snow) * t;
  out.cloud = a.cloud + (b.cloud - a.cloud) * t;
  out.fog = a.fog + (b.fog - a.fog) * t;
  out.shaft = a.shaft + (b.shaft - a.shaft) * t;
  out.star = a.star + (b.star - a.star) * t;
  out.bolt = a.bolt + (b.bolt - a.bolt) * t;
  out.warm = a.warm + (b.warm - a.warm) * t;
  out.cool = a.cool + (b.cool - a.cool) * t;
}

/* --------------------------------------------------------------------------
   Pools
   -------------------------------------------------------------------------- */

const RAIN_MAX = 620;
const SPLASH_MAX = 72;
const SNOW_MAX = 190;
const STAR_MAX = 150;
const CLOUD_MAX = 16;
const FOG_MAX = 7;
const TAU = Math.PI * 2;

const FPS = 30;
const FRAME_MS = 1000 / FPS;

/* Pre-baked colour strings: nothing is built inside the frame loop. */
const RAIN_STROKE = "rgba(212, 233, 247, 1)";
const SPLASH_STROKE = "rgba(222, 240, 252, 1)";
const STAR_FILL = "rgba(233, 244, 255, 1)";
const FLASH_FILL = "rgba(206, 228, 255, 1)";
const BOLT_FILL = "rgba(228, 240, 255, 1)";

/* --------------------------------------------------------------------------
   Sprite factory (built once, reused forever)
   -------------------------------------------------------------------------- */

function makeSprite(size: number, paint: (c: CanvasRenderingContext2D, s: number) => void) {
  const cv = document.createElement("canvas");
  cv.width = size;
  cv.height = size;
  const c = cv.getContext("2d");
  if (c) paint(c, size);
  return cv;
}

const softSprite = makeSprite(128, (c, s) => {
  const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,0.95)");
  g.addColorStop(0.45, "rgba(255,255,255,0.42)");
  g.addColorStop(0.75, "rgba(255,255,255,0.12)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, s, s);
});

const warmSprite = makeSprite(256, (c, s) => {
  const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255, 214, 138, 0.85)");
  g.addColorStop(0.3, "rgba(250, 190, 104, 0.4)");
  g.addColorStop(0.62, "rgba(238, 166, 92, 0.12)");
  g.addColorStop(1, "rgba(232, 152, 84, 0)");
  c.fillStyle = g;
  c.fillRect(0, 0, s, s);
});

const coolSprite = makeSprite(256, (c, s) => {
  const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(96, 150, 196, 0.5)");
  g.addColorStop(0.45, "rgba(58, 106, 150, 0.22)");
  g.addColorStop(1, "rgba(20, 52, 82, 0)");
  c.fillStyle = g;
  c.fillRect(0, 0, s, s);
});

const shaftSprite = (() => {
  const cv = document.createElement("canvas");
  cv.width = 96;
  cv.height = 512;
  const c = cv.getContext("2d");
  if (c) {
    const v = c.createLinearGradient(0, 0, 0, 512);
    v.addColorStop(0, "rgba(255, 243, 214, 0.5)");
    v.addColorStop(0.5, "rgba(255, 238, 196, 0.2)");
    v.addColorStop(1, "rgba(255, 234, 188, 0)");
    c.fillStyle = v;
    c.fillRect(0, 0, 96, 512);
    const h = c.createLinearGradient(0, 0, 96, 0);
    h.addColorStop(0, "rgba(0,0,0,0)");
    h.addColorStop(0.5, "rgba(0,0,0,1)");
    h.addColorStop(1, "rgba(0,0,0,0)");
    c.globalCompositeOperation = "destination-in";
    c.fillStyle = h;
    c.fillRect(0, 0, 96, 512);
  }
  return cv;
})();

/* --------------------------------------------------------------------------
   Engine
   -------------------------------------------------------------------------- */

type Inputs = {
  code: number;
  isDay: boolean;
  wind: number;
  intensity: number;
  reduce: boolean;
};

class Engine {
  private canvas: HTMLCanvasElement;
  private wrap: HTMLElement;
  private ctx: CanvasRenderingContext2D;
  private w = 1;
  private h = 1;
  private raf = 0;
  private running = false;
  private last = 0;
  private t = 0;
  private ready = false;

  private kind: Kind = "overcast";
  private feat = newFeature();
  private from = newFeature();
  private goal = newFeature();
  private mix = 1;

  private wind = 0;
  private intensity = 1;
  private reduce = false;

  private io: ResizeObserver | null = null;
  private mq: MediaQueryList | null = null;
  private staticGrad: CanvasGradient | null = null;
  private initialized = false;

  /* rain / drizzle */
  private rainX = new Float32Array(RAIN_MAX);
  private rainY = new Float32Array(RAIN_MAX);
  private rainDepth = new Float32Array(RAIN_MAX);
  private rainLen = new Float32Array(RAIN_MAX);

  /* splashes */
  private splT = new Float32Array(SPLASH_MAX);
  private splX = new Float32Array(SPLASH_MAX);
  private splY = new Float32Array(SPLASH_MAX);
  private splR = new Float32Array(SPLASH_MAX);
  private splDebt = 0;

  /* snow */
  private snowX = new Float32Array(SNOW_MAX);
  private snowY = new Float32Array(SNOW_MAX);
  private snowDepth = new Float32Array(SNOW_MAX);
  private snowPhase = new Float32Array(SNOW_MAX);

  /* stars */
  private starX = new Float32Array(STAR_MAX);
  private starY = new Float32Array(STAR_MAX);
  private starSize = new Float32Array(STAR_MAX);
  private starPhase = new Float32Array(STAR_MAX);
  private starSpeed = new Float32Array(STAR_MAX);
  private starBase = new Float32Array(STAR_MAX);

  /* clouds */
  private cloudX = new Float32Array(CLOUD_MAX);
  private cloudY = new Float32Array(CLOUD_MAX);
  private cloudW = new Float32Array(CLOUD_MAX);
  private cloudH = new Float32Array(CLOUD_MAX);
  private cloudV = new Float32Array(CLOUD_MAX);
  private cloudA = new Float32Array(CLOUD_MAX);

  /* fog bands */
  private fogX = new Float32Array(FOG_MAX);
  private fogY = new Float32Array(FOG_MAX);
  private fogW = new Float32Array(FOG_MAX);
  private fogH = new Float32Array(FOG_MAX);
  private fogV = new Float32Array(FOG_MAX);
  private fogA = new Float32Array(FOG_MAX);

  /* lightning */
  private boltX = new Float32Array(32);
  private boltY = new Float32Array(32);
  private boltN = 0;
  private branchX = new Float32Array(24);
  private branchY = new Float32Array(24);
  private branchN = 0;
  private branchStart = new Int32Array(8);
  private branchStartN = 0;
  private flashAt = -99;
  private nextFlash = 4;

  constructor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, wrap: HTMLElement) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.wrap = wrap;
    this.seed();
    this.resize();
    this.io = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this.resize()) : null;
    this.io?.observe(canvas);
    window.addEventListener("resize", this.onWindowResize);
    document.addEventListener("visibilitychange", this.onVisibility);
    if (typeof window.matchMedia === "function") {
      this.mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      this.mq.addEventListener?.("change", this.onMotionChange);
    }
  }

  /* ---------------------------------------------------------------- input */

  setInputs(next: Inputs) {
    const kind = kindFor(next.code, next.isDay);
    this.wind = Math.max(0, Math.min(140, Number.isFinite(next.wind) ? next.wind : 0));
    this.intensity = Math.max(0, Math.min(1, Number.isFinite(next.intensity) ? next.intensity : 1));
    const reduce = next.reduce || prefersReducedMotion();

    if (!this.initialized) {
      // First paint: adopt the condition instantly, no cross-fade from nothing.
      this.initialized = true;
      this.kind = kind;
      copyInto(this.feat, FEATURES[kind]);
      copyInto(this.from, this.feat);
      copyInto(this.goal, this.feat);
      this.mix = 1;
    } else if (kind !== this.kind) {
      copyInto(this.from, this.feat);
      copyInto(this.goal, FEATURES[kind]);
      this.kind = kind;
      this.mix = reduce ? 1 : 0;
      // The reduced-motion gradient is tinted per condition; re-bake it.
      this.staticGrad = null;
      if (reduce) copyInto(this.feat, this.goal);
    }

    const wasReduced = this.reduce;
    this.reduce = reduce;

    if (reduce) {
      this.stop();
      this.paintStatic();
      return;
    }
    if (wasReduced || !this.running) this.start();
  }

  /* --------------------------------------------------------------- layout */

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 1.75);
    this.w = w;
    this.h = h;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.staticGrad = null;
    if (this.reduce) this.paintStatic();
  }

  private onWindowResize = () => this.resize();

  private onVisibility = () => {
    if (document.hidden) this.stop();
    else if (!this.reduce) this.start();
  };

  private onMotionChange = () => {
    const reduce = prefersReducedMotion();
    if (reduce === this.reduce) return;
    this.reduce = reduce;
    if (reduce) {
      this.stop();
      this.paintStatic();
    } else {
      this.start();
    }
  };

  /* ----------------------------------------------------------------- seed */

  private seed() {
    const rnd = Math.random;
    for (let i = 0; i < RAIN_MAX; i++) {
      this.rainX[i] = rnd();
      this.rainY[i] = rnd();
      this.rainDepth[i] = rnd();
      this.rainLen[i] = 0.6 + rnd() * 0.9;
    }
    for (let i = 0; i < SPLASH_MAX; i++) {
      this.splT[i] = 0;
      this.splX[i] = 0;
      this.splY[i] = 0;
      this.splR[i] = 0;
    }
    for (let i = 0; i < SNOW_MAX; i++) {
      this.snowX[i] = rnd();
      this.snowY[i] = rnd();
      this.snowDepth[i] = rnd();
      this.snowPhase[i] = rnd() * TAU;
    }
    for (let i = 0; i < STAR_MAX; i++) {
      this.starX[i] = rnd();
      this.starY[i] = rnd() * 0.82;
      this.starSize[i] = 0.8 + rnd() * 1.7;
      this.starPhase[i] = rnd() * TAU;
      this.starSpeed[i] = 0.5 + rnd() * 1.6;
      this.starBase[i] = 0.28 + rnd() * 0.72;
    }
    for (let i = 0; i < CLOUD_MAX; i++) {
      this.cloudX[i] = rnd();
      this.cloudY[i] = -0.05 + rnd() * 0.72;
      this.cloudW[i] = 0.2 + rnd() * 0.34;
      this.cloudH[i] = 0.09 + rnd() * 0.16;
      this.cloudV[i] = 0.004 + rnd() * 0.012;
      this.cloudA[i] = 0.45 + rnd() * 0.55;
    }
    for (let i = 0; i < FOG_MAX; i++) {
      this.fogX[i] = rnd();
      this.fogY[i] = 0.12 + rnd() * 0.76;
      this.fogW[i] = 0.55 + rnd() * 0.6;
      this.fogH[i] = 0.2 + rnd() * 0.24;
      this.fogV[i] = 0.003 + rnd() * 0.008;
      this.fogA[i] = 0.5 + rnd() * 0.5;
    }
  }

  /* ----------------------------------------------------------------- loop */

  start() {
    if (this.running || this.reduce) return;
    this.running = true;
    this.last = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  destroy() {
    this.stop();
    this.io?.disconnect();
    this.io = null;
    window.removeEventListener("resize", this.onWindowResize);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.mq?.removeEventListener?.("change", this.onMotionChange);
    this.mq = null;
  }

  private frame = (now: number) => {
    if (!this.running) return;
    const delta = now - this.last;
    // ~30 fps cap, but on a display already running below that we draw every
    // frame instead of skipping (smoothness beats saving 0.3 ms).
    if (this.last && delta < FRAME_MS * 0.85) {
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    const dt = this.last ? Math.min(80, delta) / 1000 : FRAME_MS / 1000;
    this.last = now;
    this.t += dt;
    this.step(dt);
    this.draw();
    if (!this.ready) {
      this.ready = true;
      this.wrap.classList.add("is-ready");
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  /* ------------------------------------------------------------ simulation */

  private step(dt: number) {
    if (this.mix < 1) {
      this.mix = Math.min(1, this.mix + dt / 0.75);
      lerpInto(this.feat, this.from, this.goal, easeInOutCubic(this.mix));
    }

    const drift = (this.wind / 120) * 0.4;

    /* rain + drizzle share one pool; the active branch decides the physics */
    const rainOn = this.feat.rain > 0.01;
    const drizzleOn = this.feat.drizzle > 0.01;
    if (rainOn || drizzleOn) {
      const count = Math.round(
        RAIN_MAX * Math.min(1, Math.max(this.feat.rain, this.feat.drizzle) * this.intensity),
      );
      const speedMul = this.feat.rain >= this.feat.drizzle ? 1 : 0.36;
      for (let i = 0; i < count; i++) {
        const depth = this.rainDepth[i];
        const v = (0.85 + depth * 1.35) * speedMul;
        let y = this.rainY[i] + v * dt;
        let x = this.rainX[i] + drift * dt * (0.3 + depth);
        if (y > 1.02) {
          y -= 1.04;
          x = Math.random();
        }
        if (x > 1.03) x -= 1.06;
        else if (x < -0.03) x += 1.06;
        this.rainY[i] = y;
        this.rainX[i] = x;
      }
    }

    /* splashes */
    const splashRate = 30 * Math.min(1, this.feat.rain * this.intensity + this.feat.drizzle * 0.25);
    if (splashRate > 0.2) {
      this.splDebt += dt * splashRate;
      while (this.splDebt >= 1) {
        this.splDebt -= 1;
        for (let i = 0; i < SPLASH_MAX; i++) {
          if (this.splT[i] === 0) {
            this.splT[i] = 0.001;
            this.splX[i] = Math.random() * this.w;
            this.splY[i] = (0.06 + Math.random() * 0.92) * this.h;
            const scale = Math.max(0.65, Math.min(1.5, this.h / 900));
            this.splR[i] = (2.4 + Math.random() * 5.4) * scale * (0.8 + (this.splY[i] / this.h) * 0.5);
            break;
          }
        }
      }
    }
    for (let i = 0; i < SPLASH_MAX; i++) {
      if (this.splT[i] > 0) {
        this.splT[i] += dt * 3.1;
        if (this.splT[i] >= 1) this.splT[i] = 0;
      }
    }

    /* snow */
    if (this.feat.snow > 0.01) {
      const count = Math.round(SNOW_MAX * Math.min(1, this.feat.snow * this.intensity));
      for (let i = 0; i < count; i++) {
        const depth = this.snowDepth[i];
        const sway = Math.sin(this.t * (0.7 + depth * 0.9) + this.snowPhase[i]) * 0.012;
        let y = this.snowY[i] + (0.028 + depth * 0.07) * dt;
        let x = this.snowX[i] + (sway + drift * 0.45) * dt;
        if (y > 1.03) {
          y -= 1.06;
          x = Math.random();
        }
        if (x > 1.03) x -= 1.06;
        else if (x < -0.03) x += 1.06;
        this.snowY[i] = y;
        this.snowX[i] = x;
      }
    }

    /* clouds + fog drift */
    if (this.feat.cloud > 0.01) {
      for (let i = 0; i < CLOUD_MAX; i++) {
        let x = this.cloudX[i] + (this.cloudV[i] + drift * 0.05) * dt;
        if (x > 1.3) x -= 1.6;
        this.cloudX[i] = x;
      }
    }
    if (this.feat.fog > 0.01) {
      for (let i = 0; i < FOG_MAX; i++) {
        let x = this.fogX[i] + (this.fogV[i] + drift * 0.03) * dt;
        if (x > 1.45) x -= 1.9;
        this.fogX[i] = x;
      }
    }

    /* lightning scheduling */
    if (this.feat.bolt > 0.05) {
      if (this.t > this.nextFlash) {
        this.triggerFlash();
        this.nextFlash = this.t + 2.6 + Math.random() * 5.5;
      }
    }
  }

  private triggerFlash() {
    this.flashAt = this.t;
    let x = 0.24 + Math.random() * 0.52;
    let y = -0.03;
    this.boltN = 0;
    this.branchN = 0;
    this.branchStartN = 0;
    const steps = 17;
    for (let i = 0; i < steps; i++) {
      this.boltX[this.boltN] = x;
      this.boltY[this.boltN] = y;
      this.boltN++;
      y += 0.032 + Math.random() * 0.018;
      // A bolt is mostly vertical: tiny lateral jitter, never a long diagonal.
      x += (Math.random() - 0.5) * 0.014;
      if ((i === 7 || i === 11) && this.branchStartN < this.branchStart.length) {
        this.branchStart[this.branchStartN] = this.branchN;
        this.branchStartN++;
        let bx = x;
        let by = y;
        const dir = i === 7 ? -1 : 1;
        for (let b = 0; b < 4; b++) {
          bx += dir * (0.012 + Math.random() * 0.02);
          by += 0.014 + Math.random() * 0.014;
          if (this.branchN < this.branchX.length) {
            this.branchX[this.branchN] = bx;
            this.branchY[this.branchN] = by;
            this.branchN++;
          }
        }
      }
    }
  }

  /* ----------------------------------------------------------------- draw */

  private draw() {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    const f = this.feat;
    const inten = this.intensity;

    ctx.clearRect(0, 0, w, h);

    /* --- atmosphere glow (additive) --- */
    if (f.warm > 0.01 || f.cool > 0.01) {
      ctx.globalCompositeOperation = "lighter";
      if (f.warm > 0.01) {
        const s = Math.max(w, h) * 1.2;
        ctx.globalAlpha = 0.32 * f.warm * inten;
        ctx.drawImage(warmSprite, w * 0.66 - s / 2, -s * 0.3, s, s);
      }
      if (f.cool > 0.01) {
        const s = Math.max(w, h) * 1.7;
        ctx.globalAlpha = 0.3 * f.cool * inten;
        ctx.drawImage(coolSprite, w * 0.5 - s / 2, -s * 0.62, s, s);
      }
      ctx.globalCompositeOperation = "source-over";
    }

    /* --- stars --- */
    if (f.star > 0.01) this.drawStars(f.star * inten);

    /* --- sun shafts --- */
    if (f.shaft > 0.01) this.drawShafts(f.shaft * inten);

    /* --- cloud bank --- */
    if (f.cloud > 0.01) this.drawClouds(f.cloud);

    /* --- fog haze --- */
    if (f.fog > 0.01) this.drawFog(f.fog);

    /* --- precipitation --- */
    if (f.rain > 0.01) this.drawRain(f.rain * inten, false);
    if (f.drizzle > 0.01) this.drawRain(f.drizzle * inten, true);
    if (f.snow > 0.01) this.drawSnow(f.snow * inten);

    /* --- splashes --- */
    this.drawSplashes();

    /* --- lightning --- */
    if (f.bolt > 0.01) this.drawLightning(f.bolt);

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  private drawStars(weight: number) {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = STAR_FILL;
    const w = this.w;
    const h = this.h;
    const scale = Math.max(0.7, Math.min(1.7, h / 900));
    for (let i = 0; i < STAR_MAX; i++) {
      const tw = 0.55 + 0.45 * Math.sin(this.t * this.starSpeed[i] + this.starPhase[i]);
      ctx.globalAlpha = 0.8 * weight * this.starBase[i] * tw;
      const s = this.starSize[i] * scale;
      ctx.fillRect(this.starX[i] * w, this.starY[i] * h, s, s);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  private drawShafts(weight: number) {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    const ox = w * 0.74;
    const oy = -h * 0.12;
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 4; i++) {
      const angle = -0.5 + i * 0.29 + Math.sin(this.t * 0.14 + i * 1.7) * 0.03;
      const len = h * 1.55;
      const wid = len * (0.14 + i * 0.045);
      ctx.save();
      ctx.translate(ox, oy);
      ctx.rotate(angle);
      ctx.globalAlpha = 0.17 * weight * (0.65 + 0.35 * Math.sin(this.t * 0.42 + i * 2.1));
      ctx.drawImage(shaftSprite, -wid / 2, 0, wid, len);
      ctx.restore();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  private drawClouds(weight: number) {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    for (let i = 0; i < CLOUD_MAX; i++) {
      const cw = this.cloudW[i] * w;
      const ch = this.cloudH[i] * h;
      ctx.globalAlpha = 0.2 * weight * this.cloudA[i];
      ctx.drawImage(softSprite, this.cloudX[i] * w - cw / 2, this.cloudY[i] * h - ch / 2, cw, ch);
    }
  }

  private drawFog(weight: number) {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    for (let i = 0; i < FOG_MAX; i++) {
      const fw = this.fogW[i] * w;
      const fh = this.fogH[i] * h;
      ctx.globalAlpha = 0.15 * weight * this.fogA[i] * (0.85 + 0.15 * Math.sin(this.t * 0.3 + i));
      ctx.drawImage(softSprite, this.fogX[i] * w - fw / 2, this.fogY[i] * h - fh / 2, fw, fh);
    }
  }

  private drawRain(weight: number, fine: boolean) {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    const count = Math.round(RAIN_MAX * Math.min(1, weight));
    if (count < 1) return;
    const slant = (this.wind / 120) * 0.5;
    // Streaks are rain, not scratches: a real drop trails a dozen-ish pixels.
    // The old length was 8% of the viewport (~150 px on a 900 px tall window),
    // which read as long diagonal lines rather than falling water.
    const baseLen = h * (fine ? 0.009 : 0.016);
    ctx.strokeStyle = RAIN_STROKE;
    ctx.lineCap = "round";

    const passes = [
      { lo: 0, hi: 0.36, alpha: 0.085, width: 0.9 },
      { lo: 0.36, hi: 0.7, alpha: 0.13, width: 1.15 },
      { lo: 0.7, hi: 1.01, alpha: 0.2, width: 1.6 },
    ];

    for (let p = 0; p < passes.length; p++) {
      const pass = passes[p];
      ctx.globalAlpha = pass.alpha * Math.min(1.15, weight);
      ctx.lineWidth = pass.width;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const depth = this.rainDepth[i];
        if (depth < pass.lo || depth >= pass.hi) continue;
        const len = baseLen * this.rainLen[i] * (0.55 + depth * 0.9);
        const x = this.rainX[i] * w;
        const y = this.rainY[i] * h;
        ctx.moveTo(x, y);
        ctx.lineTo(x - slant * len * 1.15, y - len);
      }
      ctx.stroke();
    }
  }

  private drawSnow(weight: number) {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    const count = Math.round(SNOW_MAX * Math.min(1, weight));
    if (count < 1) return;
    const scale = Math.max(0.7, Math.min(1.7, h / 900));
    for (let i = 0; i < count; i++) {
      const depth = this.snowDepth[i];
      const r = (1.2 + depth * 3.2) * scale;
      ctx.globalAlpha = (0.3 + depth * 0.55) * Math.min(1, weight);
      ctx.drawImage(softSprite, this.snowX[i] * w - r, this.snowY[i] * h - r, r * 2, r * 2);
    }
  }

  private drawSplashes() {
    const ctx = this.ctx;
    ctx.strokeStyle = SPLASH_STROKE;
    ctx.lineWidth = 1;
    const buckets = [
      { lo: 0, hi: 0.4, alpha: 0.34 },
      { lo: 0.4, hi: 0.72, alpha: 0.24 },
      { lo: 0.72, hi: 1.01, alpha: 0.12 },
    ];
    for (let b = 0; b < buckets.length; b++) {
      const bucket = buckets[b];
      let any = false;
      ctx.beginPath();
      for (let i = 0; i < SPLASH_MAX; i++) {
        const t = this.splT[i];
        if (t <= 0 || t < bucket.lo || t >= bucket.hi) continue;
        any = true;
        const grow = 0.4 + t * 1.05;
        const rx = this.splR[i] * grow;
        const ry = rx * 0.46;
        // ellipse() joins the current point to the arc start with a straight
        // line, so every batch of splashes was being chained together into long
        // thin streaks across the map. Move to the arc start first.
        ctx.moveTo(this.splX[i] + rx, this.splY[i]);
        ctx.ellipse(this.splX[i], this.splY[i], rx, ry, 0, 0, TAU);
      }
      if (any) {
        ctx.globalAlpha = bucket.alpha;
        ctx.stroke();
      }
    }
  }

  private drawLightning(weight: number) {
    const age = this.t - this.flashAt;
    if (age < 0 || age > 0.75) return;
    const a = flashAlpha(age) * Math.min(1, weight);
    if (a <= 0.01) return;
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    ctx.globalCompositeOperation = "lighter";

    ctx.globalAlpha = 0.13 * a;
    ctx.fillStyle = FLASH_FILL;
    ctx.fillRect(0, 0, w, h);

    if (a > 0.12 && this.boltN > 1) {
      ctx.strokeStyle = BOLT_FILL;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (let pass = 0; pass < 3; pass++) {
        ctx.globalAlpha = a * (pass === 0 ? 0.1 : pass === 1 ? 0.34 : 0.9);
        ctx.lineWidth = pass === 0 ? 4.5 : pass === 1 ? 1.9 : 0.9;
        ctx.beginPath();
        ctx.moveTo(this.boltX[0] * w, this.boltY[0] * h);
        for (let i = 1; i < this.boltN; i++) {
          ctx.lineTo(this.boltX[i] * w, this.boltY[i] * h);
        }
        ctx.stroke();
        // Each fork is its own stroke: never bridge two unrelated branches.
        for (let s = 0; s < this.branchStartN; s++) {
          const start = this.branchStart[s];
          const end = s + 1 < this.branchStartN ? this.branchStart[s + 1] : this.branchN;
          if (end - start < 2) continue;
          ctx.beginPath();
          ctx.moveTo(this.branchX[start] * w, this.branchY[start] * h);
          for (let i = start + 1; i < end; i++) {
            ctx.lineTo(this.branchX[i] * w, this.branchY[i] * h);
          }
          ctx.stroke();
        }
      }
    }
    ctx.globalCompositeOperation = "source-over";
  }

  /* ----------------------------------------------------------- reduced mode */

  private paintStatic() {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    const f = this.feat;
    ctx.clearRect(0, 0, w, h);
    if (!this.staticGrad) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      if (f.warm > 0.3) {
        g.addColorStop(0, "rgba(244, 189, 93, 0.16)");
        g.addColorStop(0.55, "rgba(244, 189, 93, 0.05)");
        g.addColorStop(1, "rgba(244, 189, 93, 0)");
      } else if (f.star > 0.3 || f.warm === 0) {
        g.addColorStop(0, "rgba(64, 118, 164, 0.2)");
        g.addColorStop(0.6, "rgba(32, 78, 118, 0.08)");
        g.addColorStop(1, "rgba(18, 52, 84, 0)");
      } else {
        g.addColorStop(0, "rgba(126, 158, 180, 0.14)");
        g.addColorStop(1, "rgba(126, 158, 180, 0)");
      }
      this.staticGrad = g;
    }
    ctx.fillStyle = this.staticGrad;
    ctx.fillRect(0, 0, w, h);
    if (f.warm > 0.3) {
      const s = Math.max(w, h) * 1.1;
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.22 * f.warm;
      ctx.drawImage(warmSprite, w * 0.66 - s / 2, -s * 0.3, s, s);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }
    if (!this.ready) {
      this.ready = true;
      this.wrap.classList.add("is-ready");
    }
  }
}

function flashAlpha(age: number): number {
  if (age < 0) return 0;
  if (age < 0.09) return age / 0.09;
  if (age < 0.26) return 1 - (age - 0.09) / 0.17;
  if (age < 0.33) return 0;
  if (age < 0.4) return ((age - 0.33) / 0.07) * 0.5;
  if (age < 0.68) return 0.5 * (1 - (age - 0.4) / 0.28);
  return 0;
}

/* --------------------------------------------------------------------------
   Component
   -------------------------------------------------------------------------- */

export function Ambient(props: {
  code: number;
  isDay: boolean;
  wind: number;
  intensity?: number;
  reduce?: boolean;
}) {
  const { code, isDay, wind, intensity = 1, reduce = false } = props;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<Engine | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;
    const engine = new Engine(canvas, ctx, wrap);
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setInputs({ code, isDay, wind, intensity, reduce });
  }, [code, isDay, wind, intensity, reduce]);

  return (
    <div className="vw-ambient" ref={wrapRef} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
