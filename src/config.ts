// Centralised, overridable configuration.
//
// Values can be overridden at runtime via URL query params on the hash route
// (e.g. #/camera?hz=15) or via localStorage keys ("vrpose.ice", etc.), so the
// prototype can be tuned on a headset/phone without a rebuild.

export const PROTOCOL_VERSION = 1;

/** Build stamp (YYYYMMDDHHMM, UTC-3) injected at build time. "dev" when the
 * define is absent (e.g. under vitest). See vite.config.ts / vite-env.d.ts. */
export const BUILD: string = typeof __BUILD__ !== "undefined" ? __BUILD__ : "dev";

/** Default MediaPipe assets. WASM is pinned to the installed package version. */
export const MEDIAPIPE = {
  // Pin the WASM runtime to the same version as the npm package to avoid
  // runtime/loader mismatches.
  wasmBase: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm",
  // Model asset. Defaults to Google's hosted "lite" model (small, fast).
  // To self-host under GitHub Pages, drop the .task file in /public/models/
  // and set modelAssetPath to `${import.meta.env.BASE_URL}models/pose_landmarker_lite.task`.
  modelAssetPath:
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
} as const;

/** Default ICE servers. STUN only — see README for why TURN may be required. */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

export interface AppConfig {
  /** Target pose send rate from the phone, in Hz. */
  sendHz: number;
  /** Target inference rate on the phone, in Hz. */
  inferenceHz: number;
  /** Drop a frame if the DataChannel backlog exceeds this many bytes. */
  maxBufferedBytes: number;
  /** Reject a received pose packet older (by capture time) than this (ms). */
  maxPoseAgeMs: number;
  /** ICE servers for the WebRTC connection. */
  iceServers: RTCIceServer[];
}

export const DEFAULT_CONFIG: AppConfig = {
  sendHz: 20,
  inferenceHz: 20,
  maxBufferedBytes: 64 * 1024,
  maxPoseAgeMs: 2000,
  iceServers: DEFAULT_ICE_SERVERS,
};

/** Read user ICE override from localStorage (JSON array of RTCIceServer). */
export function loadIceServers(): RTCIceServer[] {
  try {
    const raw = localStorage.getItem("vrpose.ice");
    if (!raw) return DEFAULT_ICE_SERVERS;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s.urls === "string" || Array.isArray(s.urls))) {
      return parsed as RTCIceServer[];
    }
  } catch {
    /* ignore malformed override */
  }
  return DEFAULT_ICE_SERVERS;
}

/** Merge defaults with per-route query overrides. */
export function resolveConfig(params: URLSearchParams): AppConfig {
  const cfg: AppConfig = { ...DEFAULT_CONFIG, iceServers: loadIceServers() };
  const num = (key: string, cur: number): number => {
    const v = params.get(key);
    if (v == null) return cur;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : cur;
  };
  cfg.sendHz = num("hz", cfg.sendHz);
  cfg.inferenceHz = num("infhz", cfg.inferenceHz);
  cfg.maxPoseAgeMs = num("maxage", cfg.maxPoseAgeMs);
  return cfg;
}
