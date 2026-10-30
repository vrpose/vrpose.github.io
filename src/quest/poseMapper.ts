// Converts a received PoseMessage into figure-LOCAL joint positions for the
// SkeletonRenderer, applying the calibration (scale, mirror, fixed floor
// baseline, approximate lateral shift) and per-joint smoothing.
//
// Key honesty points from the spec:
//  - World landmarks are body-centred: they give articulation, NOT a global
//    pelvis translation. We derive an APPROXIMATE lateral shift from image
//    landmarks and keep depth pinned to the mirror plane (no fake metric depth).
//  - The floor baseline is CALIBRATED ONCE and fixed. We do NOT re-ground every
//    frame, so knee lifts and jumps survive.

import { Vector3 } from "three";
import type { Landmark, PoseMessage } from "../protocol/messages";
import { POSE_LANDMARK_COUNT, LM } from "../pose/landmarks";
import { Vec3OneEuro, DEFAULT_ONE_EURO, type OneEuroParams } from "../math/smoothing";
import {
  estimateLateralShift,
  measureModelHeight,
  normXCenter,
  worldLandmarkToLocal,
} from "../math/transforms";

export interface Calibration {
  scale: number;
  mirror: boolean;
  /** Local y (scaled space) of the lowest foot in the reference pose. */
  footBaselineLocal: number;
  /** Lateral hint calibration. */
  lateralEnabled: boolean;
  metersPerImageWidth: number;
  refHipCenterNormX: number;
}

export function defaultCalibration(): Calibration {
  return {
    scale: 1,
    mirror: true,
    footBaselineLocal: 0,
    lateralEnabled: false,
    metersPerImageWidth: 1.5,
    refHipCenterNormX: 0.5,
  };
}

export interface MappedPose {
  positions: (Vector3 | null)[];
  confidence: number[];
}

export class PoseMapper {
  private filters: Vec3OneEuro[] = [];
  private smoothingEnabled = true;

  constructor(params: OneEuroParams = DEFAULT_ONE_EURO) {
    for (let i = 0; i < POSE_LANDMARK_COUNT; i++) this.filters.push(new Vec3OneEuro(params));
  }

  setSmoothing(on: boolean): void {
    this.smoothingEnabled = on;
  }

  reset(): void {
    for (const f of this.filters) f.reset();
  }

  /**
   * Build a reference calibration from a standing pose + real height.
   * Returns scale and the fixed foot baseline (in scaled local space).
   */
  static buildCalibration(
    ref: PoseMessage,
    realHeightM: number,
    mirror: boolean,
  ): Calibration {
    const cal = defaultCalibration();
    cal.mirror = mirror;
    const world = ref.worldLandmarks;
    if (world && world.length >= POSE_LANDMARK_COUNT) {
      const modelH = measureModelHeight(world);
      cal.scale = realHeightM > 0 && modelH > 1e-4 ? realHeightM / modelH : 1;
      // Lowest foot in scaled local space becomes the fixed floor baseline.
      let minY = Infinity;
      for (const wl of world) {
        const y = worldLandmarkToLocal(wl, mirror).y * cal.scale;
        if (y < minY) minY = y;
      }
      cal.footBaselineLocal = Number.isFinite(minY) ? minY : 0;
      // Approximate meters-per-image-width from body height vs its image span.
      const imgSpan = imageHeightSpan(ref.landmarks);
      if (imgSpan > 1e-3 && realHeightM > 0) {
        // height occupies imgSpan of the frame height; width≈height aspect ~ use
        // realHeight / imgSpan as a coarse meters-per-normalised-unit figure.
        cal.metersPerImageWidth = realHeightM / imgSpan;
      }
    }
    cal.refHipCenterNormX = normXCenter(ref.landmarks[LM.LEFT_HIP], ref.landmarks[LM.RIGHT_HIP]);
    return cal;
  }

  /** Map a pose for rendering. `tSec` is the local render time in seconds. */
  map(pose: PoseMessage, cal: Calibration, tSec: number): MappedPose {
    const positions: (Vector3 | null)[] = new Array(POSE_LANDMARK_COUNT).fill(null);
    const confidence: number[] = new Array(POSE_LANDMARK_COUNT).fill(0);
    const world = pose.worldLandmarks;
    if (!world || world.length < POSE_LANDMARK_COUNT) return { positions, confidence };

    // Approximate lateral shift from image hip centre (NOT from world landmarks).
    let lateral = 0;
    if (cal.lateralEnabled && pose.landmarks.length >= POSE_LANDMARK_COUNT) {
      const hipX = normXCenter(pose.landmarks[LM.LEFT_HIP], pose.landmarks[LM.RIGHT_HIP]);
      lateral = estimateLateralShift({
        hipCenterNormX: hipX,
        refHipCenterNormX: cal.refHipCenterNormX,
        metersPerImageWidth: cal.metersPerImageWidth,
        mirror: cal.mirror,
      });
    }

    for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
      const wl = world[i];
      const p = worldLandmarkToLocal(wl, cal.mirror).multiplyScalar(cal.scale);
      // Fixed floor baseline (no per-frame re-grounding) + lateral hint on X.
      p.y -= cal.footBaselineLocal;
      p.x += lateral;
      const smoothed = this.smoothingEnabled ? this.filters[i].filter(p, tSec) : p;
      positions[i] = smoothed.clone();
      // Confidence from image-landmark visibility (where MediaPipe provides it).
      const v = pose.landmarks[i]?.visibility;
      confidence[i] = typeof v === "number" ? v : wl.visibility ?? 1;
    }
    return { positions, confidence };
  }
}

/** Vertical span (normalised) of the body in image space: nose.y to lowest foot. */
function imageHeightSpan(landmarks: Landmark[]): number {
  if (landmarks.length < POSE_LANDMARK_COUNT) return 0;
  const top = landmarks[LM.NOSE]?.y ?? 0;
  const feet = [LM.LEFT_HEEL, LM.RIGHT_HEEL, LM.LEFT_FOOT_INDEX, LM.RIGHT_FOOT_INDEX]
    .map((i) => landmarks[i]?.y ?? 0)
    .reduce((m, y) => Math.max(m, y), 0);
  return Math.max(0, feet - top);
}
