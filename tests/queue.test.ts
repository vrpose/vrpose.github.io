import { describe, it, expect } from "vitest";
import { LatestPoseBuffer } from "../src/protocol/queue";
import { PROTOCOL_VERSION } from "../src/config";
import type { PoseMessage } from "../src/protocol/messages";

function pose(seq: number, tCapture: number): PoseMessage {
  return {
    v: PROTOCOL_VERSION,
    t: "pose",
    seq,
    tCapture,
    video: { width: 640, height: 480, facing: "user", previewMirrored: false },
    landmarks: [{ x: 0, y: 0, z: 0 }],
  };
}

describe("LatestPoseBuffer", () => {
  it("accepts a strictly newer sequence", () => {
    const b = new LatestPoseBuffer();
    expect(b.offer(pose(1, 1000), 1000)).toBe(true);
    expect(b.offer(pose(2, 1010), 1010)).toBe(true);
    expect(b.peek()?.pose.seq).toBe(2);
  });

  it("rejects out-of-order and duplicate sequences", () => {
    const b = new LatestPoseBuffer();
    b.offer(pose(5, 1000), 1000);
    expect(b.offer(pose(4, 1005), 1005)).toBe(false); // older seq
    expect(b.offer(pose(5, 1005), 1005)).toBe(false); // duplicate seq
    expect(b.peek()?.pose.seq).toBe(5);
    expect(b.stats.rejected).toBe(2);
  });

  it("rejects stale capture timestamps even with a higher seq", () => {
    const b = new LatestPoseBuffer();
    b.offer(pose(1, 5000), 5000);
    // A later seq but an older capture time (clock glitch / reorder) is rejected.
    expect(b.offer(pose(2, 4000), 5001)).toBe(false);
  });

  it("reports local age and clears", () => {
    const b = new LatestPoseBuffer();
    b.offer(pose(1, 1000), 1000);
    expect(b.ageMs(1500)).toBe(500);
    b.clear();
    expect(b.peek()).toBeNull();
    expect(b.ageMs(1500)).toBe(Infinity);
  });

  it("supports an explicit sequence reset", () => {
    const b = new LatestPoseBuffer();
    b.offer(pose(100, 9000), 9000);
    b.clear();
    b.resetSequence();
    expect(b.offer(pose(1, 1000), 1000)).toBe(true); // restarted stream accepted
  });
});
