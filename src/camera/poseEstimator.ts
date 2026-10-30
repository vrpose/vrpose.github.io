// MediaPipe Pose Landmarker wrapper (tasks-vision, VIDEO running mode).
//
// detectForVideo() is synchronous and blocks the calling thread, so the caller
// throttles it to a target rate (see cameraMode). A Web Worker is the ideal
// home for this; it is noted as pending work in the README because the phone
// already does ONLY inference (rendering happens on the Quest), and throttling
// keeps the preview responsive for the MVP.

import {
  FilesetResolver,
  PoseLandmarker,
  type PoseLandmarkerResult,
} from "@mediapipe/tasks-vision";
import { MEDIAPIPE } from "../config";
import type { Landmark } from "../protocol/messages";

export interface PoseFrame {
  landmarks: Landmark[];
  worldLandmarks: Landmark[];
  /** Inference timestamp (ms, performance clock) passed to MediaPipe. */
  timestampMs: number;
}

export interface PoseEstimatorOptions {
  modelAssetPath?: string;
  minPoseDetectionConfidence?: number;
  minPosePresenceConfidence?: number;
  minTrackingConfidence?: number;
}

export class PoseEstimator {
  private landmarker: PoseLandmarker | null = null;
  private lastTs = -1;

  async init(opts: PoseEstimatorOptions = {}): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE.wasmBase);
    const baseOptions = {
      modelAssetPath: opts.modelAssetPath ?? MEDIAPIPE.modelAssetPath,
    };
    const common = {
      runningMode: "VIDEO" as const,
      numPoses: 1,
      minPoseDetectionConfidence: opts.minPoseDetectionConfidence ?? 0.5,
      minPosePresenceConfidence: opts.minPosePresenceConfidence ?? 0.5,
      minTrackingConfidence: opts.minTrackingConfidence ?? 0.5,
      outputSegmentationMasks: false,
    };
    try {
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { ...baseOptions, delegate: "GPU" },
        ...common,
      });
    } catch {
      // Fall back to CPU if the GPU delegate is unavailable on this device.
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { ...baseOptions, delegate: "CPU" },
        ...common,
      });
    }
  }

  get ready(): boolean {
    return this.landmarker !== null;
  }

  /** Run inference on a video frame. Returns null if no person was detected. */
  detect(video: HTMLVideoElement, timestampMs: number): PoseFrame | null {
    if (!this.landmarker) return null;
    // MediaPipe requires strictly increasing timestamps.
    if (timestampMs <= this.lastTs) timestampMs = this.lastTs + 1;
    this.lastTs = timestampMs;

    const result: PoseLandmarkerResult = this.landmarker.detectForVideo(video, timestampMs);
    if (!result.landmarks || result.landmarks.length === 0) return null;

    const landmarks = mapLandmarks(result.landmarks[0]);
    const worldLandmarks =
      result.worldLandmarks && result.worldLandmarks.length > 0
        ? mapLandmarks(result.worldLandmarks[0])
        : [];
    return { landmarks, worldLandmarks, timestampMs };
  }

  close(): void {
    this.landmarker?.close();
    this.landmarker = null;
  }
}

function mapLandmarks(
  src: ReadonlyArray<{ x: number; y: number; z: number; visibility?: number }>,
): Landmark[] {
  return src.map((p) => {
    const lm: Landmark = { x: p.x, y: p.y, z: p.z };
    // tasks-vision exposes `visibility`; `presence` is not surfaced separately
    // in the web API, so we leave it undefined rather than fabricate a value.
    if (typeof p.visibility === "number") lm.visibility = p.visibility;
    return lm;
  });
}
