// MediaPipe Pose (BlazePose) 33-landmark topology.
// Indices match the official model output order.

export const LM = {
  NOSE: 0,
  LEFT_EYE_INNER: 1,
  LEFT_EYE: 2,
  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5,
  RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;

export const POSE_LANDMARK_COUNT = 33;

export type Side = "left" | "right" | "center";

/** Joints we draw as spheres (a curated, legible subset of the 33). */
export const DRAWN_JOINTS: ReadonlyArray<{ idx: number; side: Side }> = [
  { idx: LM.NOSE, side: "center" },
  { idx: LM.LEFT_SHOULDER, side: "left" },
  { idx: LM.RIGHT_SHOULDER, side: "right" },
  { idx: LM.LEFT_ELBOW, side: "left" },
  { idx: LM.RIGHT_ELBOW, side: "right" },
  { idx: LM.LEFT_WRIST, side: "left" },
  { idx: LM.RIGHT_WRIST, side: "right" },
  { idx: LM.LEFT_INDEX, side: "left" },
  { idx: LM.RIGHT_INDEX, side: "right" },
  { idx: LM.LEFT_HIP, side: "left" },
  { idx: LM.RIGHT_HIP, side: "right" },
  { idx: LM.LEFT_KNEE, side: "left" },
  { idx: LM.RIGHT_KNEE, side: "right" },
  { idx: LM.LEFT_ANKLE, side: "left" },
  { idx: LM.RIGHT_ANKLE, side: "right" },
  { idx: LM.LEFT_HEEL, side: "left" },
  { idx: LM.RIGHT_HEEL, side: "right" },
  { idx: LM.LEFT_FOOT_INDEX, side: "left" },
  { idx: LM.RIGHT_FOOT_INDEX, side: "right" },
];

/** Bone segments between landmark indices, tagged by anatomical side. */
export const BONES: ReadonlyArray<{ a: number; b: number; side: Side }> = [
  // Torso
  { a: LM.LEFT_SHOULDER, b: LM.RIGHT_SHOULDER, side: "center" },
  { a: LM.LEFT_HIP, b: LM.RIGHT_HIP, side: "center" },
  { a: LM.LEFT_SHOULDER, b: LM.LEFT_HIP, side: "left" },
  { a: LM.RIGHT_SHOULDER, b: LM.RIGHT_HIP, side: "right" },
  // Left arm
  { a: LM.LEFT_SHOULDER, b: LM.LEFT_ELBOW, side: "left" },
  { a: LM.LEFT_ELBOW, b: LM.LEFT_WRIST, side: "left" },
  { a: LM.LEFT_WRIST, b: LM.LEFT_INDEX, side: "left" },
  // Right arm
  { a: LM.RIGHT_SHOULDER, b: LM.RIGHT_ELBOW, side: "right" },
  { a: LM.RIGHT_ELBOW, b: LM.RIGHT_WRIST, side: "right" },
  { a: LM.RIGHT_WRIST, b: LM.RIGHT_INDEX, side: "right" },
  // Left leg
  { a: LM.LEFT_HIP, b: LM.LEFT_KNEE, side: "left" },
  { a: LM.LEFT_KNEE, b: LM.LEFT_ANKLE, side: "left" },
  // Right leg
  { a: LM.RIGHT_HIP, b: LM.RIGHT_KNEE, side: "right" },
  { a: LM.RIGHT_KNEE, b: LM.RIGHT_ANKLE, side: "right" },
  // Left foot
  { a: LM.LEFT_ANKLE, b: LM.LEFT_HEEL, side: "left" },
  { a: LM.LEFT_HEEL, b: LM.LEFT_FOOT_INDEX, side: "left" },
  { a: LM.LEFT_ANKLE, b: LM.LEFT_FOOT_INDEX, side: "left" },
  // Right foot
  { a: LM.RIGHT_ANKLE, b: LM.RIGHT_HEEL, side: "right" },
  { a: LM.RIGHT_HEEL, b: LM.RIGHT_FOOT_INDEX, side: "right" },
  { a: LM.RIGHT_ANKLE, b: LM.RIGHT_FOOT_INDEX, side: "right" },
];

/** 2D image-space connections used to draw the phone-preview overlay. */
export const OVERLAY_CONNECTIONS: ReadonlyArray<[number, number]> = BONES.map(
  (b) => [b.a, b.b] as [number, number],
);

export const SIDE_COLORS: Record<Side, number> = {
  left: 0x4f9dff,
  right: 0xff8a5c,
  center: 0xc9d1e0,
};
