// Runtime validation of untrusted incoming messages. Everything that arrives
// over the DataChannel is validated here before use; malformed packets are
// rejected (never throw into the render loop).

import { PROTOCOL_VERSION } from "../config";
import type { Landmark, ProtocolMessage, PoseMessage, MessageType } from "./messages";

const MESSAGE_TYPES: ReadonlySet<string> = new Set<MessageType>([
  "hello",
  "hello-ack",
  "pose",
  "calibration",
  "status",
  "ping",
  "pong",
  "reset",
]);

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isValidLandmark(x: unknown): x is Landmark {
  if (!isObject(x)) return false;
  if (!isFiniteNumber(x.x) || !isFiniteNumber(x.y) || !isFiniteNumber(x.z)) return false;
  if (x.visibility !== undefined && !isFiniteNumber(x.visibility)) return false;
  if (x.presence !== undefined && !isFiniteNumber(x.presence)) return false;
  return true;
}

function isLandmarkArray(x: unknown, min = 1): x is Landmark[] {
  return Array.isArray(x) && x.length >= min && x.every(isValidLandmark);
}

/** Validate any protocol message. Returns the typed message or null. */
export function parseMessage(raw: unknown): ProtocolMessage | null {
  // Transport may hand us a string or an already-decoded object.
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isObject(obj)) return null;
  if (obj.v !== PROTOCOL_VERSION) return null;
  if (typeof obj.t !== "string" || !MESSAGE_TYPES.has(obj.t)) return null;

  switch (obj.t) {
    case "pose":
      return isValidPose(obj) ? (obj as unknown as PoseMessage) : null;
    case "hello":
      return typeof obj.token === "string" && typeof obj.viewer === "string"
        ? (obj as unknown as ProtocolMessage)
        : null;
    case "hello-ack":
      return typeof obj.accepted === "boolean" ? (obj as unknown as ProtocolMessage) : null;
    case "ping":
    case "pong":
      return isFiniteNumber(obj.tSent) ? (obj as unknown as ProtocolMessage) : null;
    case "status":
      if (typeof obj.state !== "string") return null;
      if (obj.heightM !== undefined && !isFiniteNumber(obj.heightM)) return null;
      if (obj.rttMs !== undefined && !isFiniteNumber(obj.rttMs)) return null;
      return obj as unknown as ProtocolMessage;
    case "calibration":
      if (obj.userHeightM !== undefined && !isFiniteNumber(obj.userHeightM)) return null;
      return obj as unknown as ProtocolMessage;
    case "reset":
      return obj as unknown as ProtocolMessage;
    default:
      return null;
  }
}

/** Strict check for a POSE message (exported for tests). */
export function isValidPose(obj: unknown): obj is PoseMessage {
  if (!isObject(obj)) return false;
  if (obj.v !== PROTOCOL_VERSION || obj.t !== "pose") return false;
  if (!isFiniteNumber(obj.seq) || obj.seq < 0) return false;
  if (!isFiniteNumber(obj.tCapture)) return false;
  if (!isObject(obj.video)) return false;
  const vid = obj.video;
  if (!isFiniteNumber(vid.width) || !isFiniteNumber(vid.height)) return false;
  if (vid.width <= 0 || vid.height <= 0) return false;
  if (typeof vid.previewMirrored !== "boolean") return false;
  if (vid.facing !== "user" && vid.facing !== "environment" && vid.facing !== "unknown") return false;
  if (!isLandmarkArray(obj.landmarks)) return false;
  if (obj.worldLandmarks !== undefined && !isLandmarkArray(obj.worldLandmarks)) return false;
  return true;
}
