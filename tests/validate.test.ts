import { describe, it, expect } from "vitest";
import { parseMessage, isValidPose } from "../src/protocol/validate";
import { PROTOCOL_VERSION } from "../src/config";

function makePose(overrides: Record<string, unknown> = {}) {
  return {
    v: PROTOCOL_VERSION,
    t: "pose",
    seq: 5,
    tCapture: 1_700_000_000_000,
    video: { width: 640, height: 480, facing: "user", previewMirrored: true },
    landmarks: [
      { x: 0.1, y: 0.2, z: 0.3, visibility: 0.9 },
      { x: 0.4, y: 0.5, z: 0.6 },
    ],
    worldLandmarks: [{ x: 0, y: 0, z: 0 }],
    ...overrides,
  };
}

describe("isValidPose", () => {
  it("accepts a well-formed pose", () => {
    expect(isValidPose(makePose())).toBe(true);
  });

  it("rejects wrong protocol version", () => {
    expect(isValidPose(makePose({ v: 999 }))).toBe(false);
  });

  it("rejects negative or non-finite seq", () => {
    expect(isValidPose(makePose({ seq: -1 }))).toBe(false);
    expect(isValidPose(makePose({ seq: Number.NaN }))).toBe(false);
  });

  it("rejects NaN landmark coordinates", () => {
    expect(isValidPose(makePose({ landmarks: [{ x: Number.NaN, y: 0, z: 0 }] }))).toBe(false);
  });

  it("rejects bad video metadata", () => {
    expect(isValidPose(makePose({ video: { width: 0, height: 480, facing: "user", previewMirrored: true } }))).toBe(false);
    expect(isValidPose(makePose({ video: { width: 640, height: 480, facing: "sideways", previewMirrored: true } }))).toBe(false);
    expect(isValidPose(makePose({ video: { width: 640, height: 480, facing: "user", previewMirrored: "yes" } }))).toBe(false);
  });

  it("rejects empty landmark list", () => {
    expect(isValidPose(makePose({ landmarks: [] }))).toBe(false);
  });

  it("allows omitted worldLandmarks but rejects malformed ones", () => {
    expect(isValidPose(makePose({ worldLandmarks: undefined }))).toBe(true);
    expect(isValidPose(makePose({ worldLandmarks: [{ x: 0, y: 0 }] }))).toBe(false);
  });
});

describe("parseMessage", () => {
  it("parses a JSON string payload", () => {
    const msg = parseMessage(JSON.stringify(makePose()));
    expect(msg?.t).toBe("pose");
  });

  it("returns null for invalid JSON", () => {
    expect(parseMessage("{not json")).toBeNull();
  });

  it("validates ping/pong/hello shapes", () => {
    expect(parseMessage({ v: PROTOCOL_VERSION, t: "ping", tSent: 123 })?.t).toBe("ping");
    expect(parseMessage({ v: PROTOCOL_VERSION, t: "ping" })).toBeNull();
    expect(parseMessage({ v: PROTOCOL_VERSION, t: "hello", token: "a", viewer: "q" })?.t).toBe("hello");
    expect(parseMessage({ v: PROTOCOL_VERSION, t: "hello", token: 5 })).toBeNull();
  });

  it("rejects unknown types and versions", () => {
    expect(parseMessage({ v: PROTOCOL_VERSION, t: "explode" })).toBeNull();
    expect(parseMessage({ v: 2, t: "reset" })).toBeNull();
  });
});
