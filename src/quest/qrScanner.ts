// QR scanning via getUserMedia + jsQR. Runs BEFORE entering immersive mode to
// keep compatibility simple, and never blocks the flow: if a camera is
// unavailable or denied, the caller falls back to manual pairing.
//
// NOTE: WebXR does NOT provide passthrough camera frames to the page, so we use
// the ordinary MediaDevices camera here (if any). On many standalone headsets
// no usable getUserMedia camera is exposed — detected at runtime, not assumed.

import jsQR from "jsqr";

export interface ScanResult {
  text: string;
}

export class QrScanner {
  private stream: MediaStream | null = null;
  private raf = 0;
  private video: HTMLVideoElement;
  private canvas = document.createElement("canvas");

  constructor() {
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
  }

  static async hasCamera(): Promise<boolean> {
    if (!navigator.mediaDevices?.enumerateDevices) return false;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.some((d) => d.kind === "videoinput");
    } catch {
      return false;
    }
  }

  get videoElement(): HTMLVideoElement {
    return this.video;
  }

  /** Start scanning. Resolves with the first decoded QR, rejects on failure. */
  async start(onError?: (e: Error) => void): Promise<ScanResult> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
    } catch (e) {
      const err = e instanceof Error ? e : new Error("No se pudo abrir la cámara");
      onError?.(err);
      throw err;
    }
    this.video.srcObject = this.stream;
    await this.video.play();

    return new Promise<ScanResult>((resolve) => {
      const tick = () => {
        if (this.video.readyState >= 2 && this.video.videoWidth > 0) {
          const w = this.video.videoWidth;
          const h = this.video.videoHeight;
          this.canvas.width = w;
          this.canvas.height = h;
          const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(this.video, 0, 0, w, h);
            const img = ctx.getImageData(0, 0, w, h);
            const code = jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
            if (code && code.data) {
              this.stop();
              resolve({ text: code.data });
              return;
            }
          }
        }
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    });
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
