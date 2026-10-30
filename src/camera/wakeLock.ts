// Screen Wake Lock with a graceful fallback (older browsers / denied).

interface WakeLockSentinelLike {
  release: () => Promise<void>;
  addEventListener: (type: string, cb: () => void) => void;
}

export class WakeLock {
  private sentinel: WakeLockSentinelLike | null = null;
  private wanted = false;
  private onVisibility = () => {
    if (this.wanted && document.visibilityState === "visible") void this.acquire();
  };

  get supported(): boolean {
    return "wakeLock" in navigator;
  }

  async request(): Promise<boolean> {
    this.wanted = true;
    document.addEventListener("visibilitychange", this.onVisibility);
    return this.acquire();
  }

  private async acquire(): Promise<boolean> {
    if (!this.supported) return false;
    try {
      const wl = (navigator as unknown as {
        wakeLock: { request: (t: "screen") => Promise<WakeLockSentinelLike> };
      }).wakeLock;
      this.sentinel = await wl.request("screen");
      this.sentinel.addEventListener("release", () => {
        this.sentinel = null;
      });
      return true;
    } catch {
      return false;
    }
  }

  async release(): Promise<void> {
    this.wanted = false;
    document.removeEventListener("visibilitychange", this.onVisibility);
    try {
      await this.sentinel?.release();
    } catch {
      /* ignore */
    }
    this.sentinel = null;
  }
}
