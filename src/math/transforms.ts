// Pure coordinate transforms. No DOM / WebXR here so these can be unit-tested
// in Node. three.js math classes are plain JS and run fine under Vitest.
//
// THREE COORDINATE SPACES (kept strictly separate — see spec):
//   1. Image space   — MediaPipe normalised landmarks, x,y in [0,1], origin
//                       top-left, z ~ relative depth. Used for lateral hints.
//   2. Body space    — MediaPipe world landmarks, meters, origin at hip centre,
//                       x right(+), y down(+), z toward camera(+). Articulated
//                       pose only; NOT a room-global position.
//   3. World space   — WebXR room coordinates (meters, y up), where we actually
//                       place the mirror figure.

import { Matrix4, Quaternion, Vector3 } from "three";
import type { Landmark } from "../protocol/messages";

const UP = new Vector3(0, 1, 0);
const LOCAL_FORWARD = new Vector3(0, 0, 1);

/** A rigid placement: where the figure's root sits and how it is oriented. */
export interface MirrorFrame {
  position: Vector3;
  quaternion: Quaternion;
}

/** Yaw-only quaternion rotating LOCAL_FORWARD (+Z) onto a horizontal direction. */
export function yawFacing(dirXZ: Vector3): Quaternion {
  const flat = new Vector3(dirXZ.x, 0, dirXZ.z);
  if (flat.lengthSq() < 1e-12) return new Quaternion();
  flat.normalize();
  return new Quaternion().setFromUnitVectors(LOCAL_FORWARD, flat);
}

/**
 * Build the mirror frame between the user and the phone.
 * The figure is placed at a horizontal fraction of the user→phone segment,
 * at `floorY`, facing the user. Orientation is yaw-only and FIXED after
 * calibration (it does not follow the head).
 */
export function buildMirrorFrame(params: {
  userPos: Vector3;
  phonePos: Vector3;
  fraction?: number; // 0 = at user, 1 = at phone
  floorY?: number;
  lateralOffset?: number; // meters, perpendicular to the user→phone line
  extraYaw?: number; // radians, user fine-tuning
}): MirrorFrame {
  const fraction = params.fraction ?? 0.5;
  const floorY = params.floorY ?? 0;
  const lateral = params.lateralOffset ?? 0;

  const userH = new Vector3(params.userPos.x, 0, params.userPos.z);
  const phoneH = new Vector3(params.phonePos.x, 0, params.phonePos.z);

  const position = userH.clone().lerp(phoneH, fraction);

  // Direction from mirror to user (what the figure faces).
  const toUser = userH.clone().sub(position);
  let quaternion = yawFacing(toUser);
  if (params.extraYaw) {
    quaternion = quaternion.multiply(new Quaternion().setFromAxisAngle(UP, params.extraYaw));
  }

  // Lateral offset is applied perpendicular to the user→phone line (horizontal).
  if (lateral !== 0) {
    const line = phoneH.clone().sub(userH);
    const perp = new Vector3().crossVectors(UP, line);
    if (perp.lengthSq() > 1e-12) position.add(perp.normalize().multiplyScalar(lateral));
  }

  position.y = floorY;
  return { position, quaternion };
}

/**
 * Reflect a point across an arbitrary plane. Generic and involutive:
 * reflecting twice returns the original; a point on the plane is unchanged;
 * the component along the normal is negated.
 */
export function reflectAcrossPlane(
  point: Vector3,
  planePoint: Vector3,
  planeNormal: Vector3,
): Vector3 {
  const n = planeNormal.clone().normalize();
  const d = point.clone().sub(planePoint).dot(n);
  return point.clone().sub(n.multiplyScalar(2 * d));
}

/**
 * Map a MediaPipe WORLD landmark (body space) into figure-LOCAL space
 * (y-up, meters). The mirror reflection is applied here, in the mirror's own
 * coordinate system, by negating the local X axis — NOT by swapping
 * left/right landmark labels. `mirror` defaults to true (a real mirror).
 */
export function worldLandmarkToLocal(wl: Landmark, mirror = true): Vector3 {
  const x = mirror ? -wl.x : wl.x; // reflection in mirror-local X
  const y = -wl.y; // MediaPipe +y is down; figure is y-up
  const z = -wl.z; // MediaPipe +z is toward camera; figure front is +Z
  return new Vector3(x, y, z);
}

/**
 * Estimate a scale correction factor from a reference standing pose.
 * MediaPipe world landmarks are already ~metric but approximate; we rescale so
 * the model's measured head-to-foot height matches the user's real height.
 * Returns 1 if the measurement is degenerate.
 */
export function estimateScaleFromHeight(
  refWorldLandmarks: Landmark[],
  realHeightM: number,
): number {
  if (!(realHeightM > 0)) return 1;
  const modelH = measureModelHeight(refWorldLandmarks);
  if (!(modelH > 1e-4)) return 1;
  return realHeightM / modelH;
}

/** Vertical extent (meters) of a set of world landmarks in y-up local space. */
export function measureModelHeight(worldLandmarks: Landmark[]): number {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const lm of worldLandmarks) {
    const y = -lm.y; // to y-up
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return 0;
  return maxY - minY;
}

/** Lowest point (local y) among a set of already-mapped local positions. */
export function footBaseline(localPositions: Vector3[]): number {
  let minY = Infinity;
  for (const p of localPositions) if (p.y < minY) minY = p.y;
  return Number.isFinite(minY) ? minY : 0;
}

/**
 * Approximate horizontal (lateral) body shift from IMAGE landmarks.
 * World landmarks are body-centred and cannot provide global translation, so
 * we derive a rough lateral offset from the hip-centre's normalised x position
 * relative to a calibration reference. This is intentionally approximate and
 * documented as such. `mirror` flips the sign to match the mirror convention.
 */
export function estimateLateralShift(params: {
  hipCenterNormX: number;
  refHipCenterNormX: number;
  metersPerImageWidth: number;
  mirror?: boolean;
}): number {
  const delta = params.hipCenterNormX - params.refHipCenterNormX;
  const sign = params.mirror ?? true ? -1 : 1;
  return sign * delta * params.metersPerImageWidth;
}

/** Midpoint of two landmarks' normalised x (e.g. hip centre). */
export function normXCenter(a: Landmark, b: Landmark): number {
  return (a.x + b.x) / 2;
}

/**
 * Similarity transform (uniform scale + rotation + translation) that best maps
 * three LOCAL points onto three WORLD points. We use it to auto-place the
 * figure from known correspondences: head↔headset and the two wrists↔tracked
 * hands. Three non-collinear points fully determine a proper similarity.
 *
 * Point order (both arrays): [head, leftWrist, rightWrist].
 * Returns a transform where world ≈ position + quaternion·(scale·local),
 * which matches three.js Object3D composition, or null if degenerate.
 */
export function similarityFrom3Points(
  local: [Vector3, Vector3, Vector3],
  world: [Vector3, Vector3, Vector3],
): { position: Vector3; quaternion: Quaternion; scale: number } | null {
  const lf = orthoFrame(local);
  const wf = orthoFrame(world);
  if (!lf || !wf || lf.scale < 1e-6) return null;

  // R = Wbasis · Lbasisᵀ (both orthonormal, right-handed → R is a proper rotation).
  const R = new Matrix4().multiplyMatrices(wf.basis, lf.basis.clone().transpose());
  const quaternion = new Quaternion().setFromRotationMatrix(R);
  const scale = wf.scale / lf.scale;

  const lc = centroid3(local);
  const wc = centroid3(world);
  const position = wc.clone().sub(lc.clone().applyQuaternion(quaternion).multiplyScalar(scale));
  return { position, quaternion, scale };
}

function centroid3(p: [Vector3, Vector3, Vector3]): Vector3 {
  return p[0].clone().add(p[1]).add(p[2]).multiplyScalar(1 / 3);
}

/** Orthonormal right-handed frame + RMS size from a point triple. */
function orthoFrame(
  p: [Vector3, Vector3, Vector3],
): { basis: Matrix4; scale: number } | null {
  const c = centroid3(p);
  // x: left wrist → right wrist.
  const x = p[2].clone().sub(p[1]);
  if (x.lengthSq() < 1e-10) return null;
  x.normalize();
  // up-ish: wrist midpoint → head, orthogonalised against x.
  const up = p[0].clone().sub(p[1].clone().add(p[2]).multiplyScalar(0.5));
  up.sub(x.clone().multiplyScalar(up.dot(x)));
  if (up.lengthSq() < 1e-10) return null; // collinear
  up.normalize();
  const z = new Vector3().crossVectors(x, up).normalize();
  up.crossVectors(z, x).normalize(); // re-orthogonalise for a clean basis
  const basis = new Matrix4().makeBasis(x, up, z);
  const scale = Math.sqrt(
    (p[0].distanceToSquared(c) + p[1].distanceToSquared(c) + p[2].distanceToSquared(c)) / 3,
  );
  return { basis, scale };
}
