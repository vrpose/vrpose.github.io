// Configurable smoothing. The One Euro filter gives low latency at speed while
// still damping jitter when nearly still — a good fit for live pose. Each
// scalar channel is filtered independently; Vec3OneEuro wraps three of them.

import { Vector3 } from "three";

export interface OneEuroParams {
  /** Minimum cutoff frequency (Hz). Lower = smoother but laggier when slow. */
  minCutoff: number;
  /** Speed coefficient. Higher = less lag when moving fast. */
  beta: number;
  /** Cutoff for the derivative. */
  dCutoff: number;
}

export const DEFAULT_ONE_EURO: OneEuroParams = {
  minCutoff: 1.4,
  beta: 0.3,
  dCutoff: 1.0,
};

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(private p: OneEuroParams = DEFAULT_ONE_EURO) {}

  /** @param t timestamp in seconds. */
  filter(x: number, t: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = t;
      return x;
    }
    const dt = Math.max(1e-3, t - this.tPrev);
    const dx = (x - this.xPrev) / dt;
    const aD = alpha(this.p.dCutoff, dt);
    const dxHat = this.dxPrev + aD * (dx - this.dxPrev);
    const cutoff = this.p.minCutoff + this.p.beta * Math.abs(dxHat);
    const a = alpha(cutoff, dt);
    const xHat = this.xPrev + a * (x - this.xPrev);
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = t;
    return xHat;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
  }
}

export class Vec3OneEuro {
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;
  private fz: OneEuroFilter;

  constructor(params: OneEuroParams = DEFAULT_ONE_EURO) {
    this.fx = new OneEuroFilter(params);
    this.fy = new OneEuroFilter(params);
    this.fz = new OneEuroFilter(params);
  }

  filter(v: Vector3, t: number, out = new Vector3()): Vector3 {
    out.set(this.fx.filter(v.x, t), this.fy.filter(v.y, t), this.fz.filter(v.z, t));
    return out;
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
    this.fz.reset();
  }
}

/** Exponential smoothing factor for a target per-call blend (frame-rate aware). */
export function expBlend(halfLifeMs: number, dtMs: number): number {
  if (halfLifeMs <= 0) return 1;
  return 1 - Math.pow(0.5, dtMs / halfLifeMs);
}
