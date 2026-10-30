// Skeleton renderer: spheres at joints, cylinders for bones, coloured by side.
// Geometry is shared across all joints/bones; only lightweight materials are
// per-element so confidence can fade them independently.

import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from "three";
import { BONES, DRAWN_JOINTS, POSE_LANDMARK_COUNT, SIDE_COLORS } from "../pose/landmarks";

const Y_AXIS = new Vector3(0, 1, 0);
const LOW_CONF = 0.4;

export class SkeletonRenderer {
  readonly root = new Group();
  private sphereGeo: SphereGeometry;
  private cylGeo: CylinderGeometry;
  private joints: { mesh: Mesh; idx: number; mat: MeshStandardMaterial }[] = [];
  private bones: { mesh: Mesh; a: number; b: number; mat: MeshStandardMaterial }[] = [];
  private last: (Vector3 | null)[] = new Array(POSE_LANDMARK_COUNT).fill(null);
  private globalOpacity = 1;

  constructor(opts: { jointRadius?: number; boneRadius?: number } = {}) {
    const jr = opts.jointRadius ?? 0.035;
    const br = opts.boneRadius ?? 0.02;
    this.sphereGeo = new SphereGeometry(jr, 12, 10);
    this.cylGeo = new CylinderGeometry(br, br, 1, 10, 1, true);

    for (const { idx, side } of DRAWN_JOINTS) {
      const mat = new MeshStandardMaterial({
        color: SIDE_COLORS[side],
        roughness: 0.5,
        metalness: 0.0,
        transparent: true,
        opacity: 1,
      });
      const mesh = new Mesh(this.sphereGeo, mat);
      mesh.visible = false;
      this.root.add(mesh);
      this.joints.push({ mesh, idx, mat });
    }
    for (const { a, b, side } of BONES) {
      const mat = new MeshStandardMaterial({
        color: SIDE_COLORS[side],
        roughness: 0.5,
        metalness: 0.0,
        transparent: true,
        opacity: 1,
      });
      const mesh = new Mesh(this.cylGeo, mat);
      mesh.visible = false;
      this.root.add(mesh);
      this.bones.push({ mesh, a, b, mat });
    }
  }

  /**
   * @param positions figure-local positions by landmark index (null = missing)
   * @param confidence visibility per landmark index (0..1)
   */
  update(positions: (Vector3 | null)[], confidence: number[]): void {
    // Keep last good position for low-confidence joints instead of snapping to
    // the origin; fade them so tracking loss is visible.
    for (const j of this.joints) {
      const p = positions[j.idx];
      const c = confidence[j.idx] ?? 0;
      if (p && c >= LOW_CONF) this.last[j.idx] = p;
      const show = this.last[j.idx];
      if (!show) {
        j.mesh.visible = false;
        continue;
      }
      j.mesh.visible = true;
      j.mesh.position.copy(show);
      j.mat.opacity = (c >= LOW_CONF ? 1 : 0.2) * this.globalOpacity;
    }

    for (const bone of this.bones) {
      const ca = confidence[bone.a] ?? 0;
      const cb = confidence[bone.b] ?? 0;
      const pa = this.last[bone.a];
      const pb = this.last[bone.b];
      // Hide bones whose endpoints are invalid or low-confidence.
      if (!pa || !pb || ca < LOW_CONF || cb < LOW_CONF) {
        bone.mesh.visible = false;
        continue;
      }
      bone.mesh.visible = true;
      orientCylinder(bone.mesh, pa, pb);
      bone.mat.opacity = this.globalOpacity;
    }
  }

  /** Dim/brighten the whole skeleton (e.g. on connection loss). */
  setGlobalOpacity(o: number): void {
    this.globalOpacity = Math.max(0, Math.min(1, o));
  }

  /** Clear retained positions so a stale pose can't appear frozen as "live". */
  resetRetained(): void {
    this.last = new Array(POSE_LANDMARK_COUNT).fill(null);
  }

  dispose(): void {
    this.sphereGeo.dispose();
    this.cylGeo.dispose();
    for (const j of this.joints) j.mat.dispose();
    for (const b of this.bones) b.mat.dispose();
    this.root.clear();
  }
}

const _dir = new Vector3();
const _mid = new Vector3();
const _q = new Quaternion();

function orientCylinder(mesh: Mesh, a: Vector3, b: Vector3): void {
  _dir.subVectors(b, a);
  const len = _dir.length();
  if (len < 1e-5) {
    mesh.visible = false;
    return;
  }
  _mid.addVectors(a, b).multiplyScalar(0.5);
  mesh.position.copy(_mid);
  _q.setFromUnitVectors(Y_AXIS, _dir.clone().normalize());
  mesh.quaternion.copy(_q);
  mesh.scale.set(1, len, 1);
}
