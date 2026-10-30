import { describe, it, expect } from "vitest";
import { Vector3 } from "three";
import { Quaternion } from "three";
import {
  buildMirrorFrame,
  reflectAcrossPlane,
  worldLandmarkToLocal,
  estimateScaleFromHeight,
  measureModelHeight,
  estimateLateralShift,
  yawFacing,
  similarityFrom3Points,
} from "../src/math/transforms";

describe("reflectAcrossPlane", () => {
  const planePoint = new Vector3(0, 0, 0);
  const normal = new Vector3(1, 0, 0);

  it("is involutive (reflecting twice returns the original)", () => {
    const p = new Vector3(3, 2, -1);
    const once = reflectAcrossPlane(p, planePoint, normal);
    const twice = reflectAcrossPlane(once, planePoint, normal);
    expect(twice.x).toBeCloseTo(p.x, 10);
    expect(twice.y).toBeCloseTo(p.y, 10);
    expect(twice.z).toBeCloseTo(p.z, 10);
  });

  it("leaves points on the plane unchanged", () => {
    const onPlane = new Vector3(0, 5, 7);
    const r = reflectAcrossPlane(onPlane, planePoint, normal);
    expect(r.distanceTo(onPlane)).toBeCloseTo(0, 10);
  });

  it("negates only the component along the normal", () => {
    const p = new Vector3(4, 9, -2);
    const r = reflectAcrossPlane(p, planePoint, normal);
    expect(r.x).toBeCloseTo(-4, 10);
    expect(r.y).toBeCloseTo(9, 10);
    expect(r.z).toBeCloseTo(-2, 10);
  });

  it("works with a non-normalised, offset plane", () => {
    const pt = new Vector3(0, 1, 0);
    const n = new Vector3(0, 3, 0); // not unit length
    const p = new Vector3(2, 4, 5);
    const r = reflectAcrossPlane(p, pt, n);
    // distance above plane is 3 -> reflected to 3 below -> y = 1 - 3 = -2
    expect(r.y).toBeCloseTo(-2, 10);
    expect(r.x).toBeCloseTo(2, 10);
    expect(r.z).toBeCloseTo(5, 10);
  });
});

describe("yawFacing / buildMirrorFrame", () => {
  it("faces the user from the mirror midpoint", () => {
    const userPos = new Vector3(0, 1.6, 0);
    const phonePos = new Vector3(0, 1.2, -4);
    const frame = buildMirrorFrame({ userPos, phonePos, fraction: 0.5, floorY: 0 });
    expect(frame.position.x).toBeCloseTo(0, 6);
    expect(frame.position.z).toBeCloseTo(-2, 6);
    expect(frame.position.y).toBeCloseTo(0, 6); // placed on the floor

    const forward = new Vector3(0, 0, 1).applyQuaternion(frame.quaternion);
    const toUser = userPos.clone().sub(frame.position).setY(0).normalize();
    expect(forward.x).toBeCloseTo(toUser.x, 5);
    expect(forward.z).toBeCloseTo(toUser.z, 5);
  });

  it("applies a lateral offset perpendicular to the user→phone line", () => {
    const userPos = new Vector3(0, 0, 0);
    const phonePos = new Vector3(0, 0, -4); // line along -Z
    const frame = buildMirrorFrame({ userPos, phonePos, lateralOffset: 1, floorY: 0 });
    // perpendicular to Z in the horizontal plane is X
    expect(Math.abs(frame.position.x)).toBeCloseTo(1, 6);
    expect(frame.position.z).toBeCloseTo(-2, 6);
  });

  it("yawFacing returns identity-ish for +Z target", () => {
    const q = yawFacing(new Vector3(0, 0, 1));
    const f = new Vector3(0, 0, 1).applyQuaternion(q);
    expect(f.z).toBeCloseTo(1, 6);
  });
});

describe("worldLandmarkToLocal", () => {
  it("flips Y and Z, and mirrors X when requested", () => {
    const wl = { x: 1, y: 2, z: 3 };
    const mirrored = worldLandmarkToLocal(wl, true);
    expect(mirrored.x).toBeCloseTo(-1, 10);
    expect(mirrored.y).toBeCloseTo(-2, 10);
    expect(mirrored.z).toBeCloseTo(-3, 10);

    const direct = worldLandmarkToLocal(wl, false);
    expect(direct.x).toBeCloseTo(1, 10);
    expect(direct.y).toBeCloseTo(-2, 10);
    expect(direct.z).toBeCloseTo(-3, 10);
  });
});

describe("scale and lateral estimation", () => {
  it("measures model height from world landmarks (y-up span)", () => {
    const lms = [
      { x: 0, y: -0.9, z: 0 }, // head above hips -> up
      { x: 0, y: 0.9, z: 0 }, // feet below hips -> down
    ];
    expect(measureModelHeight(lms)).toBeCloseTo(1.8, 10);
  });

  it("computes a scale factor to match real height", () => {
    const lms = [
      { x: 0, y: -0.85, z: 0 },
      { x: 0, y: 0.85, z: 0 },
    ]; // model height 1.7
    expect(estimateScaleFromHeight(lms, 1.7)).toBeCloseTo(1, 6);
    expect(estimateScaleFromHeight(lms, 1.87)).toBeCloseTo(1.1, 6);
  });

  it("returns 1 for degenerate input", () => {
    expect(estimateScaleFromHeight([], 1.7)).toBe(1);
    expect(estimateScaleFromHeight([{ x: 0, y: 0, z: 0 }], 0)).toBe(1);
  });

  it("lateral shift flips sign under the mirror convention", () => {
    const common = { refHipCenterNormX: 0.5, metersPerImageWidth: 2 };
    const mirrored = estimateLateralShift({ hipCenterNormX: 0.75, mirror: true, ...common });
    const direct = estimateLateralShift({ hipCenterNormX: 0.75, mirror: false, ...common });
    expect(mirrored).toBeCloseTo(-0.5, 10); // (0.75-0.5)*2 * -1
    expect(direct).toBeCloseTo(0.5, 10);
  });
});

describe("similarityFrom3Points (auto-calibration)", () => {
  const V = (x: number, y: number, z: number) => new Vector3(x, y, z);
  const local: [Vector3, Vector3, Vector3] = [V(0, 0.6, 0), V(-0.3, 0, 0.1), V(0.3, 0, -0.1)];

  it("recovers a known similarity transform (maps all 3 points)", () => {
    const s = 1.5;
    const R = new Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI / 2);
    const t = V(1, 1.6, -2);
    const world = local.map((p) => p.clone().applyQuaternion(R).multiplyScalar(s).add(t)) as [
      Vector3,
      Vector3,
      Vector3,
    ];

    const sol = similarityFrom3Points(local, world);
    expect(sol).not.toBeNull();
    expect(sol!.scale).toBeCloseTo(s, 4);
    // The solved transform must reproduce each world point.
    for (let i = 0; i < 3; i++) {
      const mapped = local[i]
        .clone()
        .applyQuaternion(sol!.quaternion)
        .multiplyScalar(sol!.scale)
        .add(sol!.position);
      expect(mapped.distanceTo(world[i])).toBeCloseTo(0, 4);
    }
  });

  it("returns null for collinear points", () => {
    const collinear: [Vector3, Vector3, Vector3] = [V(0, 0, 0), V(1, 0, 0), V(2, 0, 0)];
    expect(similarityFrom3Points(collinear, collinear)).toBeNull();
  });
});
